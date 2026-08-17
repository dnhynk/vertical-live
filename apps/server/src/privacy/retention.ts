import type { Clock } from '../clock.js'
import type {
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
 * One run walks every field of `config/retention.json` and writes exactly one
 * `retention_ledger` row per field, whatever the outcome — including "nothing was
 * expired". A sweep that deleted nothing still has to be provable, otherwise a
 * job that silently stopped running looks the same as a clean database.
 *
 * `delete` fields lose every row older than their allowed period. `refresh`
 * fields are not deleted; they are checked for having been rewritten or
 * re-verified inside their period, and a field that was not is reported as
 * `reverification_due` so T12 can alert on it. Nothing here decides on its own
 * that stale data may stay.
 */

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000

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

export interface RetentionSweeperOptions {
  readonly store: PersistenceStore
  readonly clock: Clock
  readonly config: RetentionConfig
  readonly reverify?: Reverifier
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
  /** True when the batch budget ran out before the field was clean. */
  readonly truncated: boolean
  readonly cutoffAt: string
  readonly ledgerEntryId: number
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
  readonly #logger: Logger

  constructor(options: RetentionSweeperOptions) {
    this.#store = options.store
    this.#clock = options.clock
    this.#config = options.config
    this.#reverify = options.reverify
    this.#logger = options.logger ?? silentLogger
    // A table with no declared policy is a policy hole, so it is refused at
    // construction rather than skipped at run time.
    assertSchemaCoverage(options.config, options.store.listTables())
  }

  get config(): RetentionConfig {
    return this.#config
  }

  run(): RetentionSweepResult {
    const startedAt = this.#clock.nowUtcIso()
    const entries: RetentionEntryResult[] = []
    // Column-expiry fields first, orphan fields last: a `gift_combo` row is only
    // orphaned once the inbox rows for its base key are gone, so running the two
    // in the other order would always postpone the orphan cleanup by one sweep.
    for (const field of orderedFields(this.#config.fields)) {
      entries.push(this.#sweepField(field))
    }
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
      return this.#record(field, {
        outcome: 'failed',
        cutoffAt,
        periodDays,
        recordedAt: this.#clock.nowUtcIso(),
        error: message,
      })
    }
  }

  #sweepDelete(
    field: RetentionField,
    cutoffAt: string,
    periodDays: number,
    now: string,
  ): RetentionEntryResult {
    const budget = {
      batchLimit: this.#config.sweep.batchLimit,
      maxBatches: this.#config.sweep.maxBatchesPerEntry,
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

    const deletedAt = swept.rowsDeleted > 0 ? this.#clock.nowUtcIso() : null
    if (swept.rowsUnprocessed > 0) {
      this.#logger.warn('retention deleted rows the writer had not processed', {
        fieldKey: field.key,
        rowsUnprocessed: swept.rowsUnprocessed,
      })
    }
    return this.#record(field, {
      outcome: swept.rowsDeleted > 0 ? 'deleted' : 'nothing_expired',
      cutoffAt,
      periodDays,
      recordedAt: now,
      rowsDeleted: swept.rowsDeleted,
      rowsUnprocessed: swept.rowsUnprocessed,
      truncated: swept.truncated,
      ...(deletedAt === null ? {} : { deletedAt }),
    })
  }

  /**
   * Only `gift_combo` expires by reference today. The mapping is explicit rather
   * than generic so a new `orphan` field cannot be added to the config and then
   * silently swept by the wrong statement — it fails loudly instead.
   */
  #sweepOrphans(
    field: RetentionField,
    budget: { batchLimit: number; maxBatches: number },
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
      })
      return this.#record(field, {
        outcome: swept.rowsDeleted > 0 ? 'deleted' : 'nothing_expired',
        cutoffAt,
        periodDays,
        recordedAt: now,
        rowsDeleted: swept.rowsDeleted,
        rowsUnprocessed: swept.rowsUnprocessed,
        truncated: swept.truncated,
        ...(swept.rowsDeleted > 0 ? { deletedAt: this.#clock.nowUtcIso() } : {}),
      })
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

  #record(
    field: RetentionField,
    outcome: {
      outcome: RetentionOutcome
      cutoffAt: string
      periodDays: number
      recordedAt: string
      rowsDeleted?: number
      rowsUnprocessed?: number
      truncated?: boolean
      deletedAt?: string
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
      rowsDeleted: outcome.rowsDeleted ?? 0,
      rowsUnprocessed: outcome.rowsUnprocessed ?? 0,
      deletedAt: outcome.deletedAt ?? null,
      recordedAt: outcome.recordedAt,
    })
    return {
      fieldKey: field.key,
      table: field.table,
      policy: field.policy,
      outcome: outcome.outcome,
      rowsDeleted: outcome.rowsDeleted ?? 0,
      rowsUnprocessed: outcome.rowsUnprocessed ?? 0,
      truncated: outcome.truncated ?? false,
      cutoffAt: outcome.cutoffAt,
      ledgerEntryId,
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
