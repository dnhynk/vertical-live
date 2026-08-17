import type Database from 'better-sqlite3'

import { PersistenceInvariantError } from './errors.js'

/**
 * SQL side of the retention, deletion and revocation automation (spec §12.4).
 *
 * The policy lives in `config/retention.json` and the decisions live in
 * `apps/server/src/privacy`; this module is the only place that turns them into
 * statements, so `db/index.ts`'s rule — T13 uses `PersistenceStore` instead of
 * touching SQL directly — holds for the retention job as well.
 *
 * Two things every function here has to respect:
 *
 * - **Identifiers come from a config file.** A table or column name is only ever
 *   interpolated after `assertSqlIdentifier` and after the schema has been asked
 *   whether it exists, so a config typo is a startup error instead of a
 *   statement that means something else.
 * - **Deletions are batched.** A 24/7 host accumulates inbox rows, and one
 *   unbounded `DELETE` would hold the write lock for the whole sweep. SQLite only
 *   supports `DELETE ... LIMIT` when it is compiled with
 *   `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` (https://sqlite.org/lang_delete.html),
 *   which is not guaranteed here, so batches are expressed as
 *   `WHERE rowid IN (SELECT rowid ... ORDER BY ... LIMIT ?)`.
 */

export type RetentionSource = 'youtube_api' | 'simulator' | 'internal'
export type RetentionPolicyKind = 'delete' | 'refresh'
export type RetentionReason = 'scheduled' | 'consent_revoked' | 'provider_revoked' | 'user_request'
export type RetentionOutcome =
  /** Rows were removed; `rowsDeleted > 0` and `deletedAt` is set. */
  | 'deleted'
  /** The obligation ran and nothing was past its allowed period. */
  | 'nothing_expired'
  /** A `refresh` field was rewritten or re-verified inside its period. */
  | 'reverified'
  /** A `refresh` field has not been touched inside its period (spec §12.4). */
  | 'reverification_due'
  /** A field whose table this schema does not have yet (`status: "planned"`). */
  | 'table_absent'
  /** A user deletion request against a schema that stores no identifier. */
  | 'no_stored_identifiers'
  /** The obligation could not be completed; the caller reports the error. */
  | 'failed'

/** One audit row to append. `entry_id` and the defaults are filled by SQLite. */
export interface RetentionLedgerEntry {
  readonly fieldKey: string
  readonly source: RetentionSource
  readonly purpose: string
  readonly policy: RetentionPolicyKind
  readonly reason: RetentionReason
  /** 허용 기간 in days (spec §12.4). */
  readonly allowedPeriodDays: number
  /** Scheduled runs: data older than this was no longer allowed. */
  readonly cutoffAt?: string | null
  /** Triggered runs: the absolute deadline for completing the deletion. */
  readonly deadlineAt?: string | null
  readonly outcome: RetentionOutcome
  readonly rowsDeleted?: number
  readonly rowsUnprocessed?: number
  readonly deletedAt?: string | null
  readonly recordedAt: string
}

export interface RetentionLedgerRow {
  readonly entryId: number
  readonly fieldKey: string
  readonly source: RetentionSource
  readonly purpose: string
  readonly policy: RetentionPolicyKind
  readonly reason: RetentionReason
  readonly allowedPeriodDays: number
  readonly cutoffAt: string | null
  readonly deadlineAt: string | null
  readonly outcome: RetentionOutcome
  readonly rowsDeleted: number
  readonly rowsUnprocessed: number
  readonly deletedAt: string | null
  readonly recordedAt: string
}

export interface RetentionLedgerFilter {
  readonly fieldKey?: string
  readonly reason?: RetentionReason
}

/** What one batched deletion removed. */
export interface DeleteSweepResult {
  readonly rowsDeleted: number
  /**
   * Rows that were removed while their `unfinishedColumn` was still NULL — an
   * inbox row with no processing record, an effect with no ACK. Reported, never
   * swallowed (spec §9.2).
   */
  readonly rowsUnprocessed: number
  readonly batches: number
  /** True when the batch budget ran out before the table was clean. */
  readonly truncated: boolean
}

export interface DeleteExpiredOptions {
  readonly table: string
  /** Column holding the instant the allowed period is measured from. */
  readonly column: string
  /** Rows strictly older than this instant are deleted. */
  readonly cutoffAt: string
  readonly batchLimit: number
  readonly maxBatches: number
  /** A row whose column is NULL had not finished when it was deleted. */
  readonly unfinishedColumn?: string | undefined
}

export interface DeleteAllOptions {
  readonly table: string
  readonly batchLimit: number
  readonly maxBatches: number
  readonly unfinishedColumn?: string | undefined
}

const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/

/**
 * Guards every identifier that reaches a statement. The values come from
 * `config/retention.json`, which is repository content rather than user input,
 * but a retention job that can be pointed at an arbitrary statement by a config
 * edit is not something this file should make possible.
 */
export function assertSqlIdentifier(value: string, label: string): void {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new PersistenceInvariantError(
      `${label} must be a lower-snake-case SQL identifier, got ${JSON.stringify(value)}`,
    )
  }
}

/** Every table (and the `sqlite_*` bookkeeping tables) in the open database. */
export function listTableNames(database: Database.Database): string[] {
  const rows = database
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`,
    )
    .all()
  return rows.map((row) => row.name)
}

/** Column names of one table, empty when the table does not exist. */
export function listColumnNames(database: Database.Database, table: string): string[] {
  assertSqlIdentifier(table, 'table')
  const rows = database
    .prepare<[string], { name: string }>(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
    .all(table)
  return rows.map((row) => row.name)
}

export function tableExists(database: Database.Database, table: string): boolean {
  assertSqlIdentifier(table, 'table')
  const row = database
    .prepare<[string], { count: number }>(
      `SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?`,
    )
    .get(table)
  return (row?.count ?? 0) > 0
}

/** Full `CREATE` text of every object in the schema — tables, indexes, views. */
export function schemaDefinitions(database: Database.Database): { name: string; sql: string }[] {
  const rows = database
    .prepare<[], { name: string; sql: string | null }>(
      `SELECT name, sql FROM sqlite_schema ORDER BY name`,
    )
    .all()
  return rows.map((row) => ({ name: row.name, sql: row.sql ?? '' }))
}

export function countRows(database: Database.Database, table: string): number {
  assertColumnPresent(database, table, undefined)
  const row = database
    .prepare<[], { count: number }>(`SELECT count(*) AS count FROM "${table}"`)
    .get()
  return row?.count ?? 0
}

/** Highest value of an instant column, i.e. when the table was last written. */
export function latestInstant(
  database: Database.Database,
  table: string,
  column: string,
): string | null {
  assertColumnPresent(database, table, column)
  const row = database
    .prepare<[], { latest: string | null }>(`SELECT max("${column}") AS latest FROM "${table}"`)
    .get()
  return row?.latest ?? null
}

/**
 * Deletes every row whose `column` is strictly older than `cutoffAt`, in batches.
 *
 * Each batch is one `IMMEDIATE` transaction that counts the unfinished rows of
 * exactly the set it then deletes. The `ORDER BY column, rowid` is what makes
 * "count this set" and "delete this set" the same set even when instants tie.
 */
export function deleteExpiredByColumn(
  database: Database.Database,
  options: DeleteExpiredOptions,
): DeleteSweepResult {
  assertColumnPresent(database, options.table, options.column)
  if (options.unfinishedColumn !== undefined) {
    assertColumnPresent(database, options.table, options.unfinishedColumn)
  }
  const victims = `SELECT rowid FROM "${options.table}" WHERE "${options.column}" < ? ORDER BY "${options.column}", rowid LIMIT ?`
  return runBatched(database, options, victims, [options.cutoffAt])
}

/**
 * Deletes every row of a table, in batches. Used by the revocation path, which
 * removes the authorized data regardless of its age (spec §12.4).
 */
export function deleteAllRows(
  database: Database.Database,
  options: DeleteAllOptions,
): DeleteSweepResult {
  assertColumnPresent(database, options.table, undefined)
  if (options.unfinishedColumn !== undefined) {
    assertColumnPresent(database, options.table, options.unfinishedColumn)
  }
  const victims = `SELECT rowid FROM "${options.table}" ORDER BY rowid LIMIT ?`
  return runBatched(database, options, victims, [])
}

/**
 * Deletes gift combo maxima whose base event key has no inbox row left.
 *
 * `gift_combo` has no instant of its own: the row exists only so a replayed
 * combo step applies `delta = 0` (spec §7.4). Once the inbox rows for the base
 * key are past their retention there is nothing left to deduplicate against, so
 * the maximum expires with them. The join rebuilds the base event key exactly
 * the way `eventKeyFor` does — `{source}:{broadcastId}:{messageId}`.
 */
export function deleteOrphanedGiftCombos(
  database: Database.Database,
  options: { batchLimit: number; maxBatches: number },
): DeleteSweepResult {
  assertColumnPresent(database, 'gift_combo', 'base_key')
  const victims = `SELECT rowid FROM gift_combo
     WHERE NOT EXISTS (
       SELECT 1 FROM ingest_inbox i
        WHERE i.message_id IS NOT NULL
          AND gift_combo.base_key = i.source || ':' || i.broadcast_id || ':' || i.message_id)
     ORDER BY rowid LIMIT ?`
  return runBatched(database, { ...options, table: 'gift_combo' }, victims, [])
}

interface BatchOptions {
  readonly table: string
  readonly batchLimit: number
  readonly maxBatches: number
  readonly unfinishedColumn?: string | undefined
}

function runBatched(
  database: Database.Database,
  options: BatchOptions,
  victimsSql: string,
  victimParams: readonly string[],
): DeleteSweepResult {
  assertPositiveInt(options.batchLimit, 'batchLimit')
  assertPositiveInt(options.maxBatches, 'maxBatches')

  const countUnfinished =
    options.unfinishedColumn === undefined
      ? undefined
      : database.prepare<unknown[], { count: number }>(
          `SELECT count(*) AS count FROM "${options.table}"
            WHERE rowid IN (${victimsSql}) AND "${options.unfinishedColumn}" IS NULL`,
        )
  const deleteBatch = database.prepare<unknown[]>(
    `DELETE FROM "${options.table}" WHERE rowid IN (${victimsSql})`,
  )
  const params = [...victimParams, options.batchLimit]

  let rowsDeleted = 0
  let rowsUnprocessed = 0
  let batches = 0
  while (batches < options.maxBatches) {
    const batch = database.transaction(() => {
      const unfinished = countUnfinished?.get(...params)?.count ?? 0
      const changes = deleteBatch.run(...params).changes
      return { changes, unfinished }
    })
    const { changes, unfinished } = batch.immediate()
    if (changes === 0) {
      return { rowsDeleted, rowsUnprocessed, batches, truncated: false }
    }
    batches += 1
    rowsDeleted += changes
    rowsUnprocessed += unfinished
    if (changes < options.batchLimit) {
      return { rowsDeleted, rowsUnprocessed, batches, truncated: false }
    }
  }
  // The budget ran out with a full batch still coming: the caller reports it so a
  // table that never finishes draining cannot look like a completed sweep.
  return { rowsDeleted, rowsUnprocessed, batches, truncated: true }
}

/** Appends one audit row and returns its `entry_id`. */
export function insertRetentionLedger(
  database: Database.Database,
  entry: RetentionLedgerEntry,
): number {
  const info = database
    .prepare(
      `INSERT INTO retention_ledger
         (field_key, source, purpose, policy, reason, allowed_period_days,
          cutoff_at, deadline_at, outcome, rows_deleted, rows_unprocessed,
          deleted_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.fieldKey,
      entry.source,
      entry.purpose,
      entry.policy,
      entry.reason,
      entry.allowedPeriodDays,
      entry.cutoffAt ?? null,
      entry.deadlineAt ?? null,
      entry.outcome,
      entry.rowsDeleted ?? 0,
      entry.rowsUnprocessed ?? 0,
      entry.deletedAt ?? null,
      entry.recordedAt,
    )
  return Number(info.lastInsertRowid)
}

interface LedgerColumns {
  readonly entry_id: number
  readonly field_key: string
  readonly source: string
  readonly purpose: string
  readonly policy: string
  readonly reason: string
  readonly allowed_period_days: number
  readonly cutoff_at: string | null
  readonly deadline_at: string | null
  readonly outcome: string
  readonly rows_deleted: number
  readonly rows_unprocessed: number
  readonly deleted_at: string | null
  readonly recorded_at: string
}

const LEDGER_COLUMNS = `SELECT entry_id, field_key, source, purpose, policy, reason,
         allowed_period_days, cutoff_at, deadline_at, outcome, rows_deleted,
         rows_unprocessed, deleted_at, recorded_at
    FROM retention_ledger`

/** Audit rows in insertion order, optionally narrowed to a field or a reason. */
export function listRetentionLedger(
  database: Database.Database,
  filter: RetentionLedgerFilter = {},
): RetentionLedgerRow[] {
  const clauses: string[] = []
  const params: string[] = []
  if (filter.fieldKey !== undefined) {
    clauses.push('field_key = ?')
    params.push(filter.fieldKey)
  }
  if (filter.reason !== undefined) {
    clauses.push('reason = ?')
    params.push(filter.reason)
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  const rows = database
    .prepare<string[], LedgerColumns>(`${LEDGER_COLUMNS}${where} ORDER BY entry_id`)
    .all(...params)
  return rows.map(toLedgerRow)
}

function toLedgerRow(row: LedgerColumns): RetentionLedgerRow {
  return {
    entryId: row.entry_id,
    fieldKey: row.field_key,
    source: row.source as RetentionSource,
    purpose: row.purpose,
    policy: row.policy as RetentionPolicyKind,
    reason: row.reason as RetentionReason,
    allowedPeriodDays: row.allowed_period_days,
    cutoffAt: row.cutoff_at,
    deadlineAt: row.deadline_at,
    outcome: row.outcome as RetentionOutcome,
    rowsDeleted: row.rows_deleted,
    rowsUnprocessed: row.rows_unprocessed,
    deletedAt: row.deleted_at,
    recordedAt: row.recorded_at,
  }
}

/**
 * Refuses a table or column the open schema does not have. Pass `undefined` for
 * the column to check the table only.
 */
function assertColumnPresent(
  database: Database.Database,
  table: string,
  column: string | undefined,
): void {
  assertSqlIdentifier(table, 'table')
  const columns = listColumnNames(database, table)
  if (columns.length === 0) {
    throw new PersistenceInvariantError(`retention target table ${table} does not exist`)
  }
  if (column === undefined) return
  assertSqlIdentifier(column, 'column')
  if (!columns.includes(column)) {
    throw new PersistenceInvariantError(`retention target column ${table}.${column} does not exist`)
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PersistenceInvariantError(`${label} must be a positive integer`)
  }
}
