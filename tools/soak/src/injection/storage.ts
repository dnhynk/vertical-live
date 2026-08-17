import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifySqliteError, openDatabase, type PersistenceStore } from '@vl/server'

/**
 * The two storage faults of spec §11 — "DB lock" and "disk-full" — injected as
 * **real SQLite failures**, not as hand-made error objects.
 *
 * - **DB lock**: a second connection takes the write lock with `BEGIN IMMEDIATE`
 *   and holds it. The engine's next commit waits out `busy_timeout` and then gets
 *   a genuine `SQLITE_BUSY` (https://sqlite.org/lang_transaction.html,
 *   https://sqlite.org/pragma.html#pragma_busy_timeout, 확인 2026-08-18).
 * - **disk-full**: `PRAGMA max_page_count` is exhausted, so SQLite itself raises
 *   `SQLITE_FULL` (https://sqlite.org/pragma.html#pragma_max_page_count, 확인
 *   2026-08-18). The limit is per connection, so it cannot be applied to the
 *   engine's own connection from outside; `captureDiskFullError()` therefore
 *   produces the real error object from a real full database and
 *   `withDiskFull()` makes the engine's store raise **that** object on its next
 *   write. What is injected is the timing, never the failure's identity — the
 *   `code` the classifier reads comes from SQLite.
 */

/** Holds the write lock of a real database file until it is released. */
export class WriteLockHolder {
  readonly #database: ReturnType<typeof openDatabase>
  #held = false

  private constructor(database: ReturnType<typeof openDatabase>) {
    this.#database = database
  }

  static open(file: string, busyTimeoutMs: number): WriteLockHolder {
    return new WriteLockHolder(openDatabase({ file, busyTimeoutMs }))
  }

  get held(): boolean {
    return this.#held
  }

  /** Takes the write lock immediately (`BEGIN IMMEDIATE`). */
  acquire(): void {
    if (this.#held) return
    this.#database.exec('BEGIN IMMEDIATE')
    this.#held = true
  }

  release(): void {
    if (!this.#held) return
    this.#database.exec('ROLLBACK')
    this.#held = false
  }

  close(): void {
    this.release()
    this.#database.close()
  }
}

/**
 * Produces a genuine `SQLITE_FULL` from SQLite by exhausting a connection's page
 * budget on a throwaway database. Nothing about the returned error is authored
 * here — `classifySqliteError` reads the same `code` it would read in production.
 */
export function captureDiskFullError(): unknown {
  const directory = mkdtempSync(join(tmpdir(), 'vl-soak-full-'))
  const file = join(directory, 'full.db')
  const database = openDatabase({ file, busyTimeoutMs: 100 })
  try {
    database.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT)')
    // One page of headroom over what the schema already uses: the cap cannot be
    // set below the current size, so it is read rather than guessed.
    const pages = Number(database.pragma('page_count', { simple: true }))
    database.pragma(`max_page_count = ${String(pages + 1)}`)
    const insert = database.prepare('INSERT INTO filler (blob) VALUES (?)')
    const payload = 'x'.repeat(4096)
    for (let index = 0; index < 1024; index += 1) insert.run(payload)
    throw new Error('expected SQLITE_FULL but the write budget was never exhausted')
  } catch (error) {
    if (classifySqliteError(error).kind !== 'disk_full') throw error
    return error
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Methods a full disk stops the writer from completing (spec §11 데이터 보존). */
const WRITE_METHODS = new Set<string | symbol>([
  'commitIngestBatch',
  'commitStateTransition',
  'markEffectPublished',
  'markEffectAcked',
  'markEffectExpired',
])

export interface DiskFullGate {
  /** The store the engine is given. Identical to the real one until armed. */
  readonly store: PersistenceStore
  /** Writes fail with the captured `SQLITE_FULL` from now on. */
  arm(): void
  /** The operator freed space: writes work again (spec §9.1). */
  disarm(): void
  /** How many writes the gate refused. */
  readonly refusals: number
}

/**
 * Wraps a real store so its write methods raise a real `SQLITE_FULL` while armed.
 *
 * A `Proxy` rather than a subclass: `PersistenceStore` has a private constructor
 * and private fields, so every forwarded call is applied to the **real instance**
 * and the store the engine holds is the store that owns the connection. Reads
 * (`loadRecoveryState`, `listUnackedEffects`, …) are never gated — a full disk
 * does not stop SQLite from reading, and pretending otherwise would test a
 * failure mode that does not exist.
 */
export function withDiskFull(store: PersistenceStore, error: unknown): DiskFullGate {
  let armed = false
  let refusals = 0

  const proxy = new Proxy(store, {
    get(target, property) {
      // Always read with the real instance as receiver: `PersistenceStore` has
      // private fields, and a getter invoked with the proxy as `this` throws.
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...inner: unknown[]) => unknown
      if (!WRITE_METHODS.has(property)) return method.bind(target)
      return (...args: unknown[]): unknown => {
        if (armed) {
          refusals += 1
          throw error
        }
        return method.apply(target, args)
      }
    },
  })

  return {
    store: proxy,
    arm: () => {
      armed = true
    },
    disarm: () => {
      armed = false
    },
    get refusals() {
      return refusals
    },
  }
}
