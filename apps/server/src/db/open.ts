import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import Database from 'better-sqlite3'

/**
 * Connection setup for the authoritative SQL store (spec §10.2).
 *
 * The PRAGMA choices are fixed by one requirement from `docs/tasks/TASK_SPECS.md`
 * §T4: "호스트 전원 장애 후에도 commit된 유료 이벤트가 남는다".
 *
 * - `journal_mode = WAL`: readers never block the single writer, which is what
 *   the state engine (T8) needs while `/metrics` and recovery read. WAL is also
 *   persistent — "If a process sets WAL mode, then closes and reopens the
 *   database, the database will come back in WAL mode."
 *   https://sqlite.org/wal.html (2026-08-17)
 * - `synchronous = FULL`: WAL with `synchronous = NORMAL` is explicitly *not*
 *   durable — "A transaction committed in WAL mode with synchronous=NORMAL might
 *   roll back following a power loss or system crash." FULL "will use the xSync
 *   method of the VFS to ensure that all content is safely written to the disk
 *   surface prior to continuing", and "Writers sync the WAL on every transaction
 *   commit if PRAGMA synchronous is set to FULL". `EXTRA` is documented as "no
 *   different from FULL in WAL mode", so it buys nothing here.
 *   https://sqlite.org/pragma.html#pragma_synchronous (2026-08-17)
 * - `busy_timeout`: how long a blocked writer waits before `SQLITE_BUSY`
 *   (fault matrix "DB lock", spec §11). sqlite.org fixes no value, so ours is a
 *   provisional config number (BOARD A-15).
 *   https://sqlite.org/pragma.html#pragma_busy_timeout (2026-08-17)
 * - `foreign_keys = ON`: SQLite defaults this off per connection, so a future
 *   migration that declares a reference would silently not enforce it.
 *   https://sqlite.org/foreignkeys.html#fk_enable (2026-08-17)
 */

export interface OpenDatabaseOptions {
  /** Path of the SQLite file. Parent directories are created if missing. */
  readonly file: string
  readonly busyTimeoutMs: number
}

export class DatabaseOpenError extends Error {
  constructor(message: string) {
    super(`cannot open database: ${message}`)
    this.name = 'DatabaseOpenError'
  }
}

/** PRAGMA values every connection must report after `openDatabase`. */
export const REQUIRED_PRAGMAS = Object.freeze({
  journal_mode: 'wal',
  synchronous: 2 /* FULL */,
  foreign_keys: 1,
})

export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  if (options.file === '' || options.file === ':memory:') {
    // WAL and the durability requirement both need a real file on disk.
    throw new DatabaseOpenError(`file must be a filesystem path, got ${options.file || '(empty)'}`)
  }
  if (!Number.isInteger(options.busyTimeoutMs) || options.busyTimeoutMs <= 0) {
    throw new DatabaseOpenError(`busyTimeoutMs must be a positive integer`)
  }

  mkdirSync(dirname(options.file), { recursive: true })
  const database = new Database(options.file)
  try {
    // Order matters: journal_mode has to be set before the first write, and a
    // busy_timeout has to be in place before WAL mode is negotiated with another
    // connection that may already hold the write lock.
    database.pragma(`busy_timeout = ${String(options.busyTimeoutMs)}`)
    database.pragma('journal_mode = WAL')
    database.pragma('synchronous = FULL')
    database.pragma('foreign_keys = ON')
    assertPragmas(database, options.busyTimeoutMs)
  } catch (error) {
    database.close()
    throw error
  }
  return database
}

/**
 * Reads the PRAGMAs back. `PRAGMA journal_mode = WAL` can fail silently — it
 * returns the mode actually in force — so the durability contract is verified,
 * not assumed.
 */
function assertPragmas(database: Database.Database, busyTimeoutMs: number): void {
  for (const [name, expected] of Object.entries(REQUIRED_PRAGMAS)) {
    const actual = readPragma(database, name)
    if (actual !== expected) {
      throw new DatabaseOpenError(
        `PRAGMA ${name} is ${String(actual)}, expected ${String(expected)}`,
      )
    }
  }
  const actualTimeout = readPragma(database, 'busy_timeout')
  if (actualTimeout !== busyTimeoutMs) {
    throw new DatabaseOpenError(
      `PRAGMA busy_timeout is ${String(actualTimeout)}, expected ${String(busyTimeoutMs)}`,
    )
  }
}

export function readPragma(database: Database.Database, name: string): unknown {
  const value: unknown = database.pragma(name, { simple: true })
  return value
}
