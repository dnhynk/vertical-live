import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FakeClock } from '../../testing/fake-clock.js'
import { PersistenceStore, type OpenStoreOptions } from '../store.js'

/**
 * A real on-disk database in a temporary directory. WAL and the durability
 * PRAGMAs need a file, so tests never use `:memory:` (see `db/open.ts`).
 */

export interface TempStore {
  readonly store: PersistenceStore
  readonly clock: FakeClock
  readonly file: string
  readonly directory: string
  /** Reopens the same file, as a restart would (spec §11 상태 복구). */
  reopen(): PersistenceStore
  dispose(): void
}

export const TEST_BUSY_TIMEOUT_MS = 250

export function createTempStore(
  options: Partial<Omit<OpenStoreOptions, 'file'>> = {},
): TempStore {
  const directory = mkdtempSync(join(tmpdir(), 'vl-db-'))
  const file = join(directory, 'vertical-live.db')
  const clock = options.clock instanceof FakeClock ? options.clock : new FakeClock()
  let store = PersistenceStore.open({
    file,
    busyTimeoutMs: options.busyTimeoutMs ?? TEST_BUSY_TIMEOUT_MS,
    clock,
    ...(options.worldId === undefined ? {} : { worldId: options.worldId }),
  })

  return {
    get store() {
      return store
    },
    clock,
    file,
    directory,
    reopen() {
      store.close()
      store = PersistenceStore.open({
        file,
        busyTimeoutMs: options.busyTimeoutMs ?? TEST_BUSY_TIMEOUT_MS,
        clock,
        ...(options.worldId === undefined ? {} : { worldId: options.worldId }),
      })
      return store
    },
    dispose() {
      try {
        store.close()
      } catch {
        // Already closed by a crash-window test; the directory still has to go.
      }
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
