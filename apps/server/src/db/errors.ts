/**
 * SQLite failure classification for the fault matrix (spec §11: "DB lock",
 * "disk-full"). The supervisor (T12) needs to know whether to retry the same
 * write, degrade, or stop safely — a raw `SQLITE_*` string at the call site is
 * not that decision, so the mapping lives here once.
 *
 * `better-sqlite3` throws `SqliteError` with `code` set to the extended result
 * code name, e.g. `SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`,
 * `SQLITE_CONSTRAINT_UNIQUE`. https://sqlite.org/rescode.html (2026-08-17)
 */

export type SqliteFailureKind =
  /** Another connection holds the write lock; `busy_timeout` already elapsed. */
  | 'busy'
  /** A table/shared-cache lock conflict inside the same connection group. */
  | 'locked'
  /** The data violated a declared constraint. Retrying writes the same row. */
  | 'constraint'
  /** The file or the connection is read-only. Operator/permission problem. */
  | 'readonly'
  /** Disk or quota exhausted (spec §11 "disk-full"). */
  | 'disk_full'
  /** The file is damaged or is not a database. Requires `safe_stopped`. */
  | 'corrupt'
  /** Host I/O error. */
  | 'io'
  /** Anything else, including non-SQLite exceptions. */
  | 'other'

export interface SqliteFailure {
  readonly kind: SqliteFailureKind
  /**
   * True only for lock contention: the same statement can be replayed unchanged
   * and may succeed. Every other kind needs a different decision, so a blind
   * retry loop would just repeat the failure.
   */
  readonly retryable: boolean
  /** Extended result code name, or `null` for a non-SQLite exception. */
  readonly code: string | null
}

interface SqliteErrorLike {
  readonly code?: unknown
}

/** Reads the `code` property `better-sqlite3` sets on `SqliteError`. */
export function sqliteErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as SqliteErrorLike).code
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : null
}

export function classifySqliteError(error: unknown): SqliteFailure {
  const code = sqliteErrorCode(error)
  if (code === null) {
    return { kind: 'other', retryable: false, code: null }
  }
  const kind = classifyCode(code)
  return { kind, retryable: kind === 'busy' || kind === 'locked', code }
}

function classifyCode(code: string): SqliteFailureKind {
  // Extended codes are `SQLITE_<PRIMARY>_<DETAIL>`, so the primary code is the
  // prefix. `startsWith` keeps new detail codes classified without a code change.
  if (code.startsWith('SQLITE_BUSY')) return 'busy'
  if (code.startsWith('SQLITE_LOCKED')) return 'locked'
  if (code.startsWith('SQLITE_CONSTRAINT')) return 'constraint'
  if (code.startsWith('SQLITE_READONLY')) return 'readonly'
  if (code.startsWith('SQLITE_FULL')) return 'disk_full'
  if (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB') return 'corrupt'
  if (code.startsWith('SQLITE_IOERR')) return 'io'
  return 'other'
}

/** True when the write lock was unavailable for longer than `busy_timeout`. */
export function isLockContention(error: unknown): boolean {
  const kind = classifySqliteError(error).kind
  return kind === 'busy' || kind === 'locked'
}

/**
 * Rejected because the caller's data breaks an invariant this store enforces,
 * not because SQLite failed. Separate from `SqliteFailure`: a `busy` error may
 * be retried, one of these never should be.
 */
export class PersistenceInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersistenceInvariantError'
  }
}

/** The `stateRevision` / `processedIngestSeq` monotonicity rule (spec §7.3(5)). */
export class StateRevisionError extends PersistenceInvariantError {
  constructor(message: string) {
    super(message)
    this.name = 'StateRevisionError'
  }
}

/**
 * The recovery cursor (`processedIngestSeq`) would move past inbox rows that
 * have no processing record (spec §7.3(3)(5), §11 상태 복구).
 *
 * The cursor is where the drain resumes after a restart, so a row left below it
 * without a record is never processed and never reported — the event is silently
 * lost, which spec §9.2 forbids even while degraded.
 */
export class ProcessedCursorError extends PersistenceInvariantError {
  constructor(message: string) {
    super(message)
    this.name = 'ProcessedCursorError'
  }
}

/** An effect id that is not in `effect_outbox` (spec §7.3(7)). */
export class UnknownEffectError extends PersistenceInvariantError {
  constructor(effectId: string) {
    super(`effect ${effectId} is not in the outbox`)
    this.name = 'UnknownEffectError'
  }
}

/** An ACK for an effect the server never published (spec §7.3(6)(7)). */
export class EffectNotPublishedError extends PersistenceInvariantError {
  constructor(effectId: string) {
    super(`effect ${effectId} cannot be acked before it is published`)
    this.name = 'EffectNotPublishedError'
  }
}
