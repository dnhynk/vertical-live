import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from './open.js'
import { checkpointInput } from './testing/fixtures.js'
import { createTempStore, TEST_BUSY_TIMEOUT_MS, type TempStore } from './testing/temp-store.js'

/**
 * Crash windows with a real process kill (TASK_SPECS §T4 합격 기준 1).
 *
 * The in-process variants live in `ingest.test.ts` and `state.test.ts`; those
 * prove the transaction rolls back when an exception is raised. These prove the
 * same thing when nothing runs at all: a child process is SIGKILLed while it
 * holds an open transaction, or right after it committed.
 */

const CHILD_SCRIPT = fileURLToPath(new URL('./testing/crash-child.mjs', import.meta.url))
const READY_TIMEOUT_MS = 30_000

let temp: TempStore | undefined

afterEach(() => {
  temp?.dispose()
  temp = undefined
})

/** Runs the child until it reports `ready`, then SIGKILLs it. */
async function crashChild(file: string, mode: string): Promise<void> {
  const child = spawn(process.execPath, [CHILD_SCRIPT, file, String(TEST_BUSY_TIMEOUT_MS), mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`child did not report ready in ${String(READY_TIMEOUT_MS)}ms: ${stderr}`))
    }, READY_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (!chunk.includes('ready')) return
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve()
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(
        new Error(`child exited early (code ${String(code)}, signal ${String(signal)}): ${stderr}`),
      )
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  // Wait for the OS to reap it, so the write lock is gone before we reopen.
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.on('exit', () => {
      resolve()
    })
  })
}

/** A migrated database whose own connection is closed, so the child owns the file. */
function migratedFile(): string {
  temp = createTempStore()
  const file = temp.file
  temp.store.close()
  return file
}

describe('process killed mid-transaction', () => {
  it('leaves no inbox row and no checkpoint behind', async () => {
    const file = migratedFile()
    await crashChild(file, 'inbox-then-kill')

    const database = openDatabase({ file, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS })
    try {
      expect(database.prepare('SELECT COUNT(*) AS n FROM ingest_inbox').get()).toEqual({ n: 0 })
      expect(database.prepare('SELECT COUNT(*) AS n FROM source_checkpoint').get()).toEqual({
        n: 0,
      })
    } finally {
      database.close()
    }
  })

  it('leaves the store usable, with the sequence still monotonic', async () => {
    const file = migratedFile()
    await crashChild(file, 'inbox-then-kill')

    // The recovered file is the one the restarted server opens.
    const reopened = (temp as TempStore).reopen()
    const result = reopened.commitIngestBatch([], checkpointInput('token_after_crash'))
    expect(result.checkpoint.nextPageToken).toBe('token_after_crash')
    expect(reopened.loadRecoveryState().stateRevision).toBe(0)
  })
})

describe('process killed right after a commit', () => {
  it('keeps the committed paid audit row (synchronous = FULL)', async () => {
    const file = migratedFile()
    await crashChild(file, 'commit-paid-then-kill')

    const database = openDatabase({ file, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS })
    try {
      const row = database.prepare('SELECT event_key, kind, amount_micros FROM paid_ledger').all()
      expect(row).toEqual([
        {
          event_key: 'youtube:brd_test_0001:msg_test_crash_0002',
          kind: 'SUPER_CHAT',
          amount_micros: 500_000_000,
        },
      ])
    } finally {
      database.close()
    }
  })

  it('recovers a published effect as still unacked (spec §7.3(7))', async () => {
    const file = migratedFile()
    await crashChild(file, 'publish-effect-then-kill')

    const reopened = (temp as TempStore).reopen()
    const open = reopened.listUnackedEffects()
    expect(open).toHaveLength(1)
    expect(open[0]?.effect.effectId).toBe('eff_test_crash_0001')
    expect(open[0]?.publishedAt).toBe('2026-08-16T00:05:01.500Z')
    expect(open[0]?.ackedAt).toBeNull()
    expect(reopened.loadRecoveryState().unackedEffects).toHaveLength(1)
  })
})
