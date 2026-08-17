import { openDatabase } from '@vl/server'

/**
 * The two storage faults of spec §11 — "DB lock" and "disk-full" — injected as
 * **real SQLite failures on the connection the product is using**, not as
 * hand-made error objects and not on a database nobody reads.
 *
 * - **DB lock**: a second connection takes the write lock with `BEGIN IMMEDIATE`
 *   and holds it. The engine's next commit waits out `busy_timeout` and then gets
 *   a genuine `SQLITE_BUSY` (https://sqlite.org/lang_transaction.html,
 *   https://sqlite.org/pragma.html#pragma_busy_timeout, 확인 2026-08-18).
 * - **disk-full**: the store's own connection has its page budget cut to what the
 *   file already uses, so the next transaction that needs a new page fails with a
 *   genuine `SQLITE_FULL` **inside** `commitStateTransition` and SQLite rolls it
 *   back (https://sqlite.org/pragma.html#pragma_max_page_count, 확인 2026-08-18).
 *   `max_page_count` is per connection and is not stored in the file — measured,
 *   not assumed — so it has to be applied to the connection `PersistenceStore`
 *   opened. `matrix.test.ts` captures that connection by wrapping `openDatabase`,
 *   which is the factory the production store calls.
 */

/** The subset of a `better-sqlite3` connection this module needs. */
export interface SqliteConnection {
  pragma(source: string, options?: { readonly simple?: boolean }): unknown
  exec(source: string): unknown
  close(): void
}

/** SQLite's default cap, i.e. "no cap" (`SQLITE_MAX_PAGE_COUNT`). */
export const UNLIMITED_PAGE_COUNT = 4_294_967_294

/**
 * Cuts the connection's page budget to what the database already occupies, so
 * the next page allocation fails. Returns the cap that was applied.
 *
 * It compacts first. Free pages inside the file are space the engine can still
 * write into, so a cap taken while they exist is a disk that is not actually
 * full — the writer would go on committing for a while and the drill would be
 * measuring the free list rather than the fault.
 */
export function fillDisk(connection: SqliteConnection): number {
  connection.exec('VACUUM')
  const pages = Number(connection.pragma('page_count', { simple: true }))
  connection.pragma(`max_page_count = ${String(pages)}`)
  return pages
}

/** The operator freed space (spec §9.1): the budget goes back to unlimited. */
export function freeDisk(connection: SqliteConnection): void {
  connection.pragma(`max_page_count = ${String(UNLIMITED_PAGE_COUNT)}`)
}

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
