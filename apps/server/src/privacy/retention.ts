import type { Clock } from '../clock.js'
import type {
  BatchAuditFactory,
  DeleteSweepResult,
  PersistenceStore,
  RetentionOutcome,
  RetentionPolicyKind,
} from '../db/index.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import {
  assertSchemaCoverage,
  type RetentionConfig,
  type RetentionField,
  type RetentionRefreshField,
} from './config.js'

/**
 * The scheduled retention job (spec §12.4: "각 field의 source, 목적, 허용 기간,
 * 삭제 시각을 기록하고 자동 삭제·철회 test를 Gate 2에 포함한다").
 *
 * One run walks every field of `config/retention.json` and leaves at least one
 * `retention_ledger` row per field, whatever the outcome — including "nothing was
 * expired". A sweep that deleted nothing still has to be provable, otherwise a
 * job that silently stopped running looks the same as a clean database.
 *
 * Deletions record themselves: the audit row for a batch is committed **inside the
 * transaction that deletes that batch** (review round 1, B1), so a crash or a
 * failed ledger write can leave data undeleted but never deleted-without-evidence.
 * A multi-batch field therefore produces one audit row per batch.
 *
 * `delete` fields lose every row older than their allowed period. `refresh`
 * fields are not deleted; they are checked for having been rewritten or
 * re-verified inside their period, and a field that was not is reported as
 * `reverification_due` so T12 can alert on it. Nothing here decides on its own
 * that stale data may stay.
 */

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The `retention_ledger` could not be written at all, so this field's failure has
 * nowhere to be recorded. Aborts the sweep instead of being folded into a result.
 */
export class RetentionLedgerUnavailableError extends Error {
  readonly fieldKey: string
  readonly recordCause: unknown

  constructor(fieldKey: string, cause: unknown, recordCause: unknown) {
    super(
      `retention for ${fieldKey} failed (${describe(cause)}) and the failure could not be recorded in retention_ledger (${describe(recordCause)}); the sweep is aborted because it has nowhere to leave evidence (spec §12.4)`,
    )
    this.name = 'RetentionLedgerUnavailableError'
    this.fieldKey = fieldKey
    this.recordCause = recordCause
    this.cause = cause
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Verdict for a `refresh` field whose period elapsed without a rewrite. */
export type ReverifyVerdict =
  /** Permission still covers it and it may stay for another period. */
  | 'still_authorized'
  /** Permission is gone: the field's rows are deleted now. */
  | 'delete'

/**
 * Answers "is this still authorized?" for a `refresh` field. Left injectable
 * because the answer is an operations decision, not something this job can
 * derive; without it the sweep records the obligation instead of assuming.
 */
export type Reverifier = (field: RetentionRefreshField) => ReverifyVerdict

/**
 * The in-memory half of a consent deletion, when this process has a consent
 * directory (`ConsentDirectory.forgetDeleted`).
 *
 * A sweep deletes `viewer_consent` rows with a batched `DELETE`, so it never
 * learns which references it removed and cannot use the directory's own deletion
 * boundary. Without this the buffered display name of a viewer whose row the
 * sweep just deleted stayed attributable (review round 2, B2).
 */
export interface ConsentBufferReconciler {
  /** Drops buffered actors whose row is gone; returns how many. Never a name. */
  forgetDeleted(): number
}

export interface RetentionSweeperOptions {
  readonly store: PersistenceStore
  readonly clock: Clock
  readonly config: RetentionConfig
  readonly reverify?: Reverifier
  /** Passed only while the consent gate is open; closed, nothing buffers a name. */
  readonly identity?: ConsentBufferReconciler
  readonly logger?: Logger
}

export interface RetentionEntryResult {
  readonly fieldKey: string
  readonly table: string
  readonly policy: RetentionPolicyKind
  readonly outcome: RetentionOutcome
  readonly rowsDeleted: number
  /** Deleted rows the single writer had not recorded a result for (spec §9.2). */
  readonly rowsUnprocessed: number
  /** True when the batch budget ran out with rows still expired. */
  readonly truncated: boolean
  readonly cutoffAt: string
  /** Audit rows this field wrote: one per deleting batch, or one for a no-op. */
  readonly ledgerEntryIds: readonly number[]
  /** Present when the field's obligation could not be completed. */
  readonly error?: string
}

export interface RetentionSweepResult {
  readonly startedAt: string
  readonly finishedAt: string
  readonly entries: readonly RetentionEntryResult[]
  readonly rowsDeleted: number
  readonly rowsUnprocessed: number
  /** Fields whose re-verification period elapsed without a rewrite. */
  readonly reverificationDue: readonly string[]
  /** Fields the batch budget could not finish; the next run continues them. */
  readonly truncated: readonly string[]
  readonly failed: readonly string[]
  /** True when every field's obligation was satisfied by this run. */
  readonly clean: boolean
}

export class RetentionSweeper {
  readonly #store: PersistenceStore
  readonly #clock: Clock
  readonly #config: RetentionConfig
  readonly #reverify: Reverifier | undefined
  readonly #identity: ConsentBufferReconciler | undefined
  readonly #logger: Logger

  constructor(options: RetentionSweeperOptions) {
    this.#store = options.store
    this.#clock = options.clock
    this.#config = options.config
    this.#reverify = options.reverify
    this.#identity = options.identity
    this.#logger = options.logger ?? silentLogger
    // A table with no declared policy — or a field whose declared columns no
    // longer match the table — is a policy hole, so it is refused at construction
    // rather than skipped at run time (review round 1, M1).
    assertSchemaCoverage(options.config, options.store.describeSchema())
  }

  get config(): RetentionConfig {
    return this.#config
  }

  run(): RetentionSweepResult {
    const startedAt = this.#clock.nowUtcIso()
    const entries: RetentionEntryResult[] = []
    let buffered = 0
    // Column-expiry fields first, orphan fields last: a `gift_combo` row is only
    // orphaned once the inbox rows for its base key are gone, so running the two
    // in the other order would always postpone the orphan cleanup by one sweep.
    try {
      for (const field of orderedFields(this.#config.fields)) {
        entries.push(this.#sweepField(field))
        // The consent rows are gone the moment this field returns, so the
        // buffered names go with them *here* rather than at the end of the run
        // (review round 3). The end-of-run call alone put the deletion and the
        // memory boundary on opposite sides of every later field: with the
        // shipped config `metrics_daily` is swept next, and a failing ledger
        // write there aborted the run after the consent rows were already
        // committed as deleted — leaving a deleted viewer's name attributable
        // by `takeActor` until the next hourly tick (spec §12.4, D-9).
        if (field.personalIdentifiers === 'consented_identity') {
          buffered += this.#identity?.forgetDeleted() ?? 0
        }
      }
    } catch (error) {
      // The other half of the same boundary: an abort anywhere in the loop —
      // including from the consent field itself, whose own ledger failure throws
      // before the reconcile above — still reconciles the buffer before the
      // error reaches the scheduler.
      try {
        this.#identity?.forgetDeleted()
      } catch (reconcileError) {
        // Logged, never thrown: replacing `error` here would hide why the sweep
        // aborted, and both failures reach the scheduler's sink as one failed run.
        this.#logger.error('buffered actors could not be reconciled after an aborted sweep', {
          message: describe(reconcileError),
        })
      }
      throw error
    }
    // Unconditional, and after every field: a row deleted here is deleted for
    // good, so the buffer must not be able to outlive it by one sweep. The cost
    // is bounded by the buffer (see `forgetDeleted`), not by the tables.
    buffered += this.#identity?.forgetDeleted() ?? 0
    const finishedAt = this.#clock.nowUtcIso()
    const result: RetentionSweepResult = {
      startedAt,
      finishedAt,
      entries,
      rowsDeleted: entries.reduce((sum, entry) => sum + entry.rowsDeleted, 0),
      rowsUnprocessed: entries.reduce((sum, entry) => sum + entry.rowsUnprocessed, 0),
      reverificationDue: entries
        .filter((entry) => entry.outcome === 'reverification_due')
        .map((entry) => entry.fieldKey),
      truncated: entries.filter((entry) => entry.truncated).map((entry) => entry.fieldKey),
      failed: entries.filter((entry) => entry.outcome === 'failed').map((entry) => entry.fieldKey),
      clean: entries.every(
        (entry) =>
          !entry.truncated && entry.outcome !== 'failed' && entry.outcome !== 'reverification_due',
      ),
    }
    this.#logger.info('retention sweep finished', {
      rowsDeleted: result.rowsDeleted,
      rowsUnprocessed: result.rowsUnprocessed,
      reverificationDue: result.reverificationDue.length,
      failed: result.failed.length,
      bufferedActorsDropped: buffered,
    })
    return result
  }

  #sweepField(field: RetentionField): RetentionEntryResult {
    const periodDays = allowedPeriodDaysOf(field)
    const now = this.#clock.nowUtcIso()
    const cutoffAt = minusDays(now, periodDays)

    if (!this.#store.hasTable(field.table)) {
      // Declared `planned`: the owning task has not created the table yet. The
      // config loader already refuses a `present` field with no table, so this is
      // the only way to get here.
      return this.#record(field, {
        outcome: 'table_absent',
        cutoffAt,
        periodDays,
        recordedAt: now,
      })
    }

    try {
      return field.policy === 'delete'
        ? this.#sweepDelete(field, cutoffAt, periodDays, now)
        : this.#sweepRefresh(field, cutoffAt, periodDays, now)
    } catch (error) {
      const message = (error as Error).message
      this.#logger.error('retention field failed', { fieldKey: field.key, message })
      try {
        return this.#record(field, {
          outcome: 'failed',
          cutoffAt,
          periodDays,
          recordedAt: this.#clock.nowUtcIso(),
          error: message,
        })
      } catch (recordError) {
        // The ledger itself is unwritable, so this field's failure cannot be
        // recorded either. That must not be swallowed into a result object: it is
        // the one condition under which the sweep has nowhere to leave evidence,
        // so it aborts the run and reaches the scheduler's error sink.
        throw new RetentionLedgerUnavailableError(field.key, error, recordError)
      }
    }
  }

  #sweepDelete(
    field: RetentionField,
    cutoffAt: string,
    periodDays: number,
    now: string,
  ): RetentionEntryResult {
    // The audit row for each batch is built here and committed *inside* that
    // batch's transaction (review round 1, B1): rows can never leave the database
    // without the `retention_ledger` row that records their deletion.
    const audit: BatchAuditFactory = (counts) => ({
      fieldKey: field.key,
      source: field.source,
      purpose: field.purpose,
      policy: field.policy,
      reason: 'scheduled',
      allowedPeriodDays: periodDays,
      cutoffAt,
      deadlineAt: null,
      outcome: 'deleted',
      rowsDeleted: counts.rowsDeleted,
      rowsUnprocessed: counts.rowsUnprocessed,
      deletedAt: this.#clock.nowUtcIso(),
      recordedAt: this.#clock.nowUtcIso(),
    })
    const budget = {
      batchLimit: this.#config.sweep.batchLimit,
      maxBatches: this.#config.sweep.maxBatchesPerEntry,
      audit,
    }
    const swept: DeleteSweepResult =
      field.expiry.kind === 'orphan'
        ? this.#sweepOrphans(field, budget)
        : this.#store.deleteExpiredByColumn({
            table: field.table,
            column: field.expiry.column,
            cutoffAt,
            unfinishedColumn: field.unfinishedColumn,
            ...budget,
          })

    if (swept.rowsUnprocessed > 0) {
      this.#logger.warn('retention deleted rows the writer had not processed', {
        fieldKey: field.key,
        rowsUnprocessed: swept.rowsUnprocessed,
      })
    }
    if (swept.rowsDeleted === 0) {
      // Nothing was deleted, so there is no evidence at risk: this row is the
      // proof that the obligation ran at all.
      return this.#record(field, {
        outcome: 'nothing_expired',
        cutoffAt,
        periodDays,
        recordedAt: now,
        truncated: swept.truncated,
      })
    }
    return {
      fieldKey: field.key,
      table: field.table,
      policy: field.policy,
      outcome: 'deleted',
      rowsDeleted: swept.rowsDeleted,
      rowsUnprocessed: swept.rowsUnprocessed,
      truncated: swept.truncated,
      cutoffAt,
      ledgerEntryIds: swept.ledgerEntryIds,
    }
  }

  /**
   * Only `gift_combo` expires by reference today. The mapping is explicit rather
   * than generic so a new `orphan` field cannot be added to the config and then
   * silently swept by the wrong statement — it fails loudly instead.
   */
  #sweepOrphans(
    field: RetentionField,
    budget: { batchLimit: number; maxBatches: number; audit: BatchAuditFactory },
  ): DeleteSweepResult {
    if (field.table !== 'gift_combo') {
      throw new Error(
        `no orphan sweep is implemented for ${field.table}; add one in privacy/retention.ts before declaring expiry.kind = "orphan"`,
      )
    }
    return this.#store.deleteOrphanedGiftCombos(budget)
  }

  #sweepRefresh(
    field: RetentionField,
    cutoffAt: string,
    periodDays: number,
    now: string,
  ): RetentionEntryResult {
    if (field.policy !== 'refresh' || field.expiry.kind !== 'column') {
      throw new Error(`refresh field ${field.key} must expire by column`)
    }
    const latest = this.#store.latestInstant(field.table, field.expiry.column)
    if (latest === null) {
      // Nothing is retained, so there is nothing to re-verify.
      return this.#record(field, {
        outcome: 'nothing_expired',
        cutoffAt,
        periodDays,
        recordedAt: now,
      })
    }
    if (latest >= cutoffAt) {
      return this.#record(field, { outcome: 'reverified', cutoffAt, periodDays, recordedAt: now })
    }

    const verdict = this.#reverify?.(field)
    if (verdict === 'still_authorized') {
      return this.#record(field, { outcome: 'reverified', cutoffAt, periodDays, recordedAt: now })
    }
    if (verdict === 'delete') {
      const swept = this.#store.deleteAllRows({
        table: field.table,
        batchLimit: this.#config.sweep.batchLimit,
        maxBatches: this.#config.sweep.maxBatchesPerEntry,
        unfinishedColumn: field.unfinishedColumn,
        // Same atomicity rule as `#sweepDelete`: evidence inside the transaction.
        audit: (counts) => ({
          fieldKey: field.key,
          source: field.source,
          purpose: field.purpose,
          policy: field.policy,
          reason: 'scheduled',
          allowedPeriodDays: periodDays,
          cutoffAt,
          deadlineAt: null,
          outcome: 'deleted',
          rowsDeleted: counts.rowsDeleted,
          rowsUnprocessed: counts.rowsUnprocessed,
          deletedAt: this.#clock.nowUtcIso(),
          recordedAt: this.#clock.nowUtcIso(),
        }),
      })
      if (swept.rowsDeleted === 0) {
        return this.#record(field, {
          outcome: 'nothing_expired',
          cutoffAt,
          periodDays,
          recordedAt: now,
          truncated: swept.truncated,
        })
      }
      return {
        fieldKey: field.key,
        table: field.table,
        policy: field.policy,
        outcome: 'deleted',
        rowsDeleted: swept.rowsDeleted,
        rowsUnprocessed: swept.rowsUnprocessed,
        truncated: swept.truncated,
        cutoffAt,
        ledgerEntryIds: swept.ledgerEntryIds,
      }
    }
    // No verifier wired: record the obligation instead of assuming an answer.
    this.#logger.warn('retention field is due for re-verification', {
      fieldKey: field.key,
      lastWrittenAt: latest,
      cutoffAt,
    })
    return this.#record(field, {
      outcome: 'reverification_due',
      cutoffAt,
      periodDays,
      recordedAt: now,
    })
  }

  /**
   * Records an outcome that deleted nothing. Deletions record themselves inside
   * their own transaction (`#sweepDelete`), so this path never claims rows.
   */
  #record(
    field: RetentionField,
    outcome: {
      outcome: Exclude<RetentionOutcome, 'deleted'>
      cutoffAt: string
      periodDays: number
      recordedAt: string
      truncated?: boolean
      error?: string
    },
  ): RetentionEntryResult {
    const ledgerEntryId = this.#store.recordRetention({
      fieldKey: field.key,
      source: field.source,
      purpose: field.purpose,
      policy: field.policy,
      reason: 'scheduled',
      allowedPeriodDays: outcome.periodDays,
      cutoffAt: outcome.cutoffAt,
      deadlineAt: null,
      outcome: outcome.outcome,
      rowsDeleted: 0,
      rowsUnprocessed: 0,
      deletedAt: null,
      recordedAt: outcome.recordedAt,
    })
    return {
      fieldKey: field.key,
      table: field.table,
      policy: field.policy,
      outcome: outcome.outcome,
      rowsDeleted: 0,
      rowsUnprocessed: 0,
      truncated: outcome.truncated ?? false,
      cutoffAt: outcome.cutoffAt,
      ledgerEntryIds: [ledgerEntryId],
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    }
  }
}

/** `delete` fields first, `orphan` expiry last (see `run`). */
function orderedFields(fields: readonly RetentionField[]): RetentionField[] {
  return [
    ...fields.filter((field) => field.expiry.kind === 'column'),
    ...fields.filter((field) => field.expiry.kind === 'orphan'),
  ]
}

export function allowedPeriodDaysOf(field: RetentionField): number {
  return field.policy === 'delete' ? field.allowedPeriodDays : field.reverifyPeriodDays
}

/** `instant - days`, as an absolute UTC instant. */
export function minusDays(instant: string, days: number): string {
  const parsed = Date.parse(instant)
  if (Number.isNaN(parsed)) throw new TypeError(`not an instant: ${instant}`)
  return new Date(parsed - days * MILLIS_PER_DAY).toISOString()
}

/** `instant + days`, as an absolute UTC instant. */
export function plusDays(instant: string, days: number): string {
  const parsed = Date.parse(instant)
  if (Number.isNaN(parsed)) throw new TypeError(`not an instant: ${instant}`)
  return new Date(parsed + days * MILLIS_PER_DAY).toISOString()
}
