import { afterEach, describe, expect, it } from 'vitest'

import { classifySqliteError, isLockContention, sqliteErrorCode } from './errors.js'
import { openDatabase, readPragma } from './open.js'
import { checkpointInput, grpcEnvelope } from './testing/fixtures.js'
import { createTempStore, type TempStore } from './testing/temp-store.js'

/**
 * `busy_timeout` and the lock classification of the fault matrix row "DB lock"
 * (spec §11). WAL lets readers run during a write, but there is still exactly one
 * writer, so a second writer has to wait and then fail in a way the supervisor
 * can act on.
 */

const BUSY_TIMEOUT_MS = 200

let temp: TempStore | undefined

afterEach(() => {
  temp?.dispose()
  temp = undefined
})

describe('classifySqliteError', () => {
  it('maps lock contention to a retryable failure', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_TIMEOUT']) {
      const failure = classifySqliteError(Object.assign(new Error('busy'), { code }))
      expect(failure).toEqual({ kind: 'busy', retryable: true, code })
    }
    const locked = classifySqliteError(
      Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED' }),
    )
    expect(locked.kind).toBe('locked')
    expect(locked.retryable).toBe(true)
  })

  it('maps the non-retryable failures the fault matrix names', () => {
    const cases: readonly [string, string][] = [
      ['SQLITE_CONSTRAINT_UNIQUE', 'constraint'],
      ['SQLITE_READONLY_DBMOVED', 'readonly'],
      ['SQLITE_FULL', 'disk_full'],
      ['SQLITE_CORRUPT_VTAB', 'corrupt'],
      ['SQLITE_NOTADB', 'corrupt'],
      ['SQLITE_IOERR_WRITE', 'io'],
      ['SQLITE_MISUSE', 'other'],
    ]
    for (const [code, kind] of cases) {
      const failure = classifySqliteError(Object.assign(new Error(code), { code }))
      expect(failure.kind).toBe(kind)
      expect(failure.retryable).toBe(false)
    }
  })

  it('treats a non-SQLite exception as an unclassified failure', () => {
    const failure = classifySqliteError(new Error('boom'))
    expect(failure).toEqual({ kind: 'other', retryable: false, code: null })
    expect(sqliteErrorCode(new Error('boom'))).toBeNull()
    expect(sqliteErrorCode({ code: 'ENOENT' })).toBeNull()
    expect(isLockContention(new Error('boom'))).toBe(false)
  })
})

describe('busy_timeout', () => {
  it('is applied to the connection', () => {
    temp = createTempStore({ busyTimeoutMs: BUSY_TIMEOUT_MS })
    const probe = openDatabase({ file: temp.file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      expect(readPragma(probe, 'busy_timeout')).toBe(BUSY_TIMEOUT_MS)
    } finally {
      probe.close()
    }
  })

  it('waits out the timeout and then reports retryable lock contention', () => {
    temp = createTempStore({ busyTimeoutMs: BUSY_TIMEOUT_MS })
    const blocker = openDatabase({ file: temp.file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    let caught: unknown
    const startedAt = process.hrtime.bigint()
    try {
      // A second connection holds the single write lock. `BEGIN IMMEDIATE` takes
      // it up front, which is exactly what the store's write transactions do.
      blocker.exec('BEGIN IMMEDIATE')
      blocker.prepare('INSERT INTO gift_combo (base_key, stored_max) VALUES (?, ?)').run('a', 1)
      try {
        temp.store.commitIngestBatch([grpcEnvelope('text-message-event')], checkpointInput())
      } catch (error) {
        caught = error
      }
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

    const failure = classifySqliteError(caught)
    expect(failure.kind).toBe('busy')
    expect(failure.retryable).toBe(true)
    expect(isLockContention(caught)).toBe(true)
    // It blocked rather than failing straight away, i.e. the timeout is in force.
    expect(elapsedMs).toBeGreaterThanOrEqual(BUSY_TIMEOUT_MS * 0.5)

    // Nothing of the blocked transaction was written.
    expect(temp.store.drainUnprocessed(0, 10)).toEqual([])
  })

  it('succeeds once the other writer releases the lock', () => {
    temp = createTempStore({ busyTimeoutMs: BUSY_TIMEOUT_MS })
    const blocker = openDatabase({ file: temp.file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    blocker.exec('BEGIN IMMEDIATE')
    blocker.exec('ROLLBACK')
    blocker.close()

    const result = temp.store.commitIngestBatch(
      [grpcEnvelope('text-message-event')],
      checkpointInput(),
    )
    expect(result.insertedCount).toBe(1)
  })

  it('lets a reader run while a writer holds the lock (WAL)', () => {
    temp = createTempStore({ busyTimeoutMs: BUSY_TIMEOUT_MS })
    temp.store.commitIngestBatch([grpcEnvelope('text-message-event')], checkpointInput())

    const writer = openDatabase({ file: temp.file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      writer.exec('BEGIN IMMEDIATE')
      writer.prepare('INSERT INTO gift_combo (base_key, stored_max) VALUES (?, ?)').run('a', 1)
      // The drain is what recovery and `/metrics` do; it must not block on the
      // single writer.
      expect(temp.store.drainUnprocessed(0, 10)).toHaveLength(1)
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  })
})
