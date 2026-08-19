import type { Clock } from '../clock.js'
import type {
  DeleteSweepResult,
  PersistenceStore,
  RetentionLedgerEntry,
  RetentionOutcome,
  RetentionReason,
} from '../db/index.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { SecretVault } from '../secrets/vault.js'
import type { AuthEvent, AuthEventSink, AuthRevokedEvent } from '../youtube/auth/events.js'
import { REFRESH_TOKEN_SECRET } from '../youtube/auth/token-manager.js'
import type { RetentionConfig, RetentionField, RevocationClass } from './config.js'
import { plusDays, type ConsentBufferReconciler } from './retention.js'

/**
 * Consent-withdrawal automation (spec §12.4):
 *
 * - "client-side consent 철회는 token을 즉시 revoke하고 그 동의로 접근·저장한
 *   Authorized Data를 최대 7일 안에 삭제한다"
 * - "Google 설정에서의 권한 철회는 정책의 별도 최대 30일 규칙을 적용한다"
 *
 * The trigger is T3's `auth_revoked` event. Deletion runs immediately in both
 * branches — waiting out a deadline buys nothing — and the branch decides the
 * deadline that gets recorded, so "was this done inside the window the policy
 * gave" is answerable from `retention_ledger` alone.
 *
 * **Why this handler does not call `TokenManager.revokeGrant()`.** That method is
 * what *emits* `auth_revoked` (`youtube/auth/token-manager.ts`, `#latchRevoked`),
 * so calling it from the handler would re-enter the path that invoked the handler.
 * It is also never needed, for every reason in the union:
 *
 * - `operator_revoked` — `revokeGrant()` already revoked at Google and deleted the
 *   stored token before emitting.
 * - `invalid_grant` — the provider already refuses the grant; there is nothing
 *   left to revoke there.
 * - `missing_refresh_token` — no token is stored, so there is nothing to send.
 *
 * What the handler does own is the guarantee that **no usable grant is left on
 * this host**: it deletes the refresh token from the vault, which is idempotent
 * and cannot re-enter anything. That absence is also the durable record of the
 * withdrawal — if the process dies mid-deletion, the next refresh finds no token,
 * emits `auth_revoked(missing_refresh_token)` and the deletion runs again.
 */

export type GrantRevokeOutcome =
  /** A stored refresh token was found and removed. */
  | 'erased'
  /** Nothing was stored, so no usable grant remained. */
  | 'nothing_stored'

export interface GrantRevoker {
  /** Ensures no usable grant remains on this host. Idempotent. */
  revoke(): Promise<GrantRevokeOutcome>
}

/** The vault-backed revoker: deletes T3's stored refresh token. */
export function vaultGrantRevoker(vault: SecretVault): GrantRevoker {
  return {
    async revoke(): Promise<GrantRevokeOutcome> {
      const existed = await vault.delete(REFRESH_TOKEN_SECRET)
      return existed ? 'erased' : 'nothing_stored'
    },
  }
}

export interface RevocationHandlerOptions {
  readonly store: PersistenceStore
  readonly clock: Clock
  readonly config: RetentionConfig
  readonly grantRevoker: GrantRevoker
  /**
   * The in-memory half of the consent deletion, when this process has a consent
   * directory. Passed only while the identity gate is open; closed, nothing
   * buffers a name.
   *
   * A revocation deletes `viewer_consent` by SQL batch exactly as the sweep
   * does, so it cannot use the directory's own deletion boundary either.
   */
  readonly identity?: ConsentBufferReconciler
  readonly logger?: Logger
}

export interface RevocationEntryResult {
  readonly fieldKey: string
  readonly table: string
  readonly outcome: RetentionOutcome
  readonly rowsDeleted: number
  readonly rowsUnprocessed: number
  readonly truncated: boolean
  /** Audit rows this field wrote: one per deleting batch, or one for a no-op. */
  readonly ledgerEntryIds: readonly number[]
  readonly error?: string
}

export interface RevocationResult {
  readonly reason: AuthRevokedEvent['reason']
  readonly revocationClass: RevocationClass
  /** The event's own instant: the moment consent ended. */
  readonly revokedAt: string
  /** `revokedAt + allowedPeriodDays` (7 days client-side, 30 provider-side). */
  readonly deadlineAt: string
  readonly allowedPeriodDays: number
  readonly grantOutcome: GrantRevokeOutcome
  readonly entries: readonly RevocationEntryResult[]
  readonly rowsDeleted: number
  readonly completedAt: string
  /** Fields whose deletion did not finish: failed or out of batch budget. */
  readonly incomplete: readonly string[]
  /** True when every authorized field was cleared before the deadline. */
  readonly withinDeadline: boolean
}

export class RevocationHandler {
  readonly #store: PersistenceStore
  readonly #clock: Clock
  readonly #config: RetentionConfig
  readonly #grantRevoker: GrantRevoker
  readonly #identity: ConsentBufferReconciler | undefined
  readonly #logger: Logger

  constructor(options: RevocationHandlerOptions) {
    this.#store = options.store
    this.#clock = options.clock
    this.#config = options.config
    this.#grantRevoker = options.grantRevoker
    this.#identity = options.identity
    this.#logger = options.logger ?? silentLogger
  }

  /** Authorized API Data fields this schema actually has, in config order. */
  get authorizedFields(): readonly RetentionField[] {
    return this.#config.fields.filter(
      (field) => field.dataClass === 'authorized_api_data' && field.status === 'present',
    )
  }

  async handle(event: AuthRevokedEvent): Promise<RevocationResult> {
    const revocationClass = this.#config.revocation.reasonClass[event.reason]
    const allowedPeriodDays =
      revocationClass === 'client_side'
        ? this.#config.revocation.clientSideDeletionDays
        : this.#config.revocation.providerSideDeletionDays
    const deadlineAt = plusDays(event.at, allowedPeriodDays)
    const reason: RetentionReason =
      revocationClass === 'client_side' ? 'consent_revoked' : 'provider_revoked'

    // First: leave no usable grant on the host. Done before deletion so a crash
    // in the middle still ends with "no token", which re-triggers this path.
    const grantOutcome = await this.#grantRevoker.revoke()

    const entries: RevocationEntryResult[] = []
    try {
      for (const field of this.authorizedFields) {
        entries.push(this.#deleteField(field, { reason, allowedPeriodDays, deadlineAt }))
        // The same boundary the sweep uses (review round 3): the consent rows are
        // gone as soon as this field returns, so the buffered names those rows
        // authorized are dropped here rather than after the remaining fields —
        // a later field aborting must not be able to leave a deleted viewer's
        // name attributable by `takeActor` for the rest of the process's life.
        if (field.personalIdentifiers === 'consented_identity') {
          this.#identity?.forgetDeleted()
        }
      }
    } catch (error) {
      // The abort is the error sink's to report; the buffer is reconciled first,
      // including when the consent field itself was the one that threw.
      try {
        this.#identity?.forgetDeleted()
      } catch (reconcileError) {
        // Logged, never thrown: replacing `error` would hide why the revocation
        // failed, and both failures end the same revocation.
        this.#logger.error('buffered actors could not be reconciled after a failed revocation', {
          message: (reconcileError as Error).message,
        })
      }
      throw error
    }
    const completedAt = this.#clock.nowUtcIso()
    const incomplete = entries
      .filter((entry) => entry.truncated || entry.outcome === 'failed')
      .map((entry) => entry.fieldKey)

    const result: RevocationResult = {
      reason: event.reason,
      revocationClass,
      revokedAt: event.at,
      deadlineAt,
      allowedPeriodDays,
      grantOutcome,
      entries,
      rowsDeleted: entries.reduce((sum, entry) => sum + entry.rowsDeleted, 0),
      completedAt,
      incomplete,
      withinDeadline: incomplete.length === 0 && completedAt <= deadlineAt,
    }
    this.#logger.warn('consent revoked: authorized data deleted', {
      reason: event.reason,
      revocationClass,
      rowsDeleted: result.rowsDeleted,
      deadlineAt,
      withinDeadline: result.withinDeadline,
    })
    return result
  }

  #deleteField(field: RetentionField, context: RevocationContext): RevocationEntryResult {
    // The whole table goes, not just the expired part: the consent that allowed
    // this data is gone, so its age no longer matters (spec §12.4).
    //
    // The audit row for each batch is committed inside that batch's transaction
    // (review round 1, B1), so a revocation cannot end with data gone and no
    // record of the deletion that removed it.
    let swept: DeleteSweepResult
    try {
      swept = this.#store.deleteAllRows({
        table: field.table,
        batchLimit: this.#config.sweep.batchLimit,
        maxBatches: this.#config.sweep.maxBatchesPerEntry,
        unfinishedColumn: field.unfinishedColumn,
        audit: (counts) =>
          this.#entry(field, context, {
            outcome: 'deleted',
            rowsDeleted: counts.rowsDeleted,
            rowsUnprocessed: counts.rowsUnprocessed,
          }),
      })
    } catch (error) {
      const message = (error as Error).message
      this.#logger.error('revocation deletion failed', { fieldKey: field.key, message })
      return {
        fieldKey: field.key,
        table: field.table,
        outcome: 'failed',
        rowsDeleted: 0,
        rowsUnprocessed: 0,
        truncated: false,
        // If this insert also fails the whole revocation rejects, which the
        // required error sink reports (review round 1, B2).
        ledgerEntryIds: [
          this.#store.recordRetention(
            this.#entry(field, context, {
              outcome: 'failed',
              rowsDeleted: 0,
              rowsUnprocessed: 0,
            }),
          ),
        ],
        error: message,
      }
    }

    if (swept.rowsDeleted === 0) {
      return {
        fieldKey: field.key,
        table: field.table,
        outcome: 'nothing_expired',
        rowsDeleted: 0,
        rowsUnprocessed: 0,
        truncated: swept.truncated,
        ledgerEntryIds: [
          this.#store.recordRetention(
            this.#entry(field, context, {
              outcome: 'nothing_expired',
              rowsDeleted: 0,
              rowsUnprocessed: 0,
            }),
          ),
        ],
      }
    }
    return {
      fieldKey: field.key,
      table: field.table,
      outcome: 'deleted',
      rowsDeleted: swept.rowsDeleted,
      rowsUnprocessed: swept.rowsUnprocessed,
      truncated: swept.truncated,
      ledgerEntryIds: swept.ledgerEntryIds,
    }
  }

  #entry(
    field: RetentionField,
    context: RevocationContext,
    swept: { outcome: RetentionOutcome; rowsDeleted: number; rowsUnprocessed: number },
  ): RetentionLedgerEntry {
    return {
      fieldKey: field.key,
      source: field.source,
      purpose: field.purpose,
      policy: 'delete',
      reason: context.reason,
      allowedPeriodDays: context.allowedPeriodDays,
      cutoffAt: null,
      deadlineAt: context.deadlineAt,
      outcome: swept.outcome,
      rowsDeleted: swept.rowsDeleted,
      rowsUnprocessed: swept.rowsUnprocessed,
      deletedAt: swept.rowsDeleted > 0 ? this.#clock.nowUtcIso() : null,
      recordedAt: this.#clock.nowUtcIso(),
    }
  }
}

interface RevocationContext {
  readonly reason: RetentionReason
  readonly allowedPeriodDays: number
  readonly deadlineAt: string
}

export interface RevocationAuthEventSinkOptions {
  readonly handler: RevocationHandler
  /** Required: where a finished revocation goes (T12 alerts on `withinDeadline`). */
  readonly onResult: (result: RevocationResult) => void
  /** Required: where a failed revocation goes. There is no silent default. */
  readonly onError: (error: unknown) => void
  readonly logger?: Logger
}

/** One recorded failure of the sink, kept so a lost callback cannot hide it. */
export interface RevocationFailure {
  readonly reason: AuthRevokedEvent['reason']
  readonly at: string
  /** `handler` is the revocation itself; the others are a caller sink that threw. */
  readonly stage: 'handler' | 'onResult' | 'onError'
  readonly error: unknown
}

/**
 * Adapts the async handler to T3's synchronous `AuthEventSink`, so T12 can wire
 * revocation-driven deletion by handing this sink to the `TokenManager`.
 *
 * `emit` cannot await, so runs are serialized on an internal queue and `pending`
 * exposes its tail. Both callbacks are **required** and validated at construction
 * (review round 1, B2): the earlier optional `onError` meant a missed T12 wire
 * turned a failed privacy deletion into a resolved promise and nothing else. Belt
 * and braces, every failure is also kept in `failures` and logged at error level,
 * so an `onError` that itself throws still leaves the failure observable.
 *
 * The queue is the subtle part (review round 2, M2). A sink that threw used to
 * leave the tail rejected, and a rejected tail makes `.then(onFulfilled)` skip the
 * work — so every *later* `auth_revoked` in that process was silently dropped,
 * which is exactly the §12.4 obligation this class exists to keep. Callback errors
 * are now contained inside the run, and the next run is chained onto both settled
 * states, so a poisoned tail cannot stop the queue.
 */
export class RevocationAuthEventSink implements AuthEventSink {
  readonly #handler: RevocationHandler
  readonly #onResult: (result: RevocationResult) => void
  readonly #onError: (error: unknown) => void
  readonly #logger: Logger
  readonly #failures: RevocationFailure[] = []
  #pending: Promise<void> = Promise.resolve()

  constructor(options: RevocationAuthEventSinkOptions) {
    requireSink(options.onResult, 'onResult')
    requireSink(options.onError, 'onError')
    this.#handler = options.handler
    this.#onResult = options.onResult
    this.#onError = options.onError
    this.#logger = options.logger ?? silentLogger
  }

  /**
   * Resolves when every revocation started so far has finished. It never
   * rejects — failures are delivered to `onError` and recorded in `failures`,
   * because a rejected tail would stop the queue (review round 2, M2).
   */
  get pending(): Promise<void> {
    return this.#pending
  }

  /** Every failed revocation this sink has seen, oldest first. */
  get failures(): readonly RevocationFailure[] {
    return this.#failures
  }

  /** True when any revocation failed. T12's health aggregation can read this. */
  get failed(): boolean {
    return this.#failures.length > 0
  }

  emit(event: AuthEvent): void {
    if (event.type !== 'auth_revoked') return
    // Chained onto *both* settled states: `#run` is written not to reject, and
    // this is the second guard so no future rejection can strand the queue.
    const run = (): Promise<void> => this.#run(event)
    this.#pending = this.#pending.then(run, run)
  }

  async #run(event: AuthRevokedEvent): Promise<void> {
    try {
      const result = await this.#handler.handle(event)
      this.#notify(() => this.#onResult(result), event, 'onResult')
    } catch (error) {
      this.#failures.push({ reason: event.reason, at: event.at, stage: 'handler', error })
      this.#logger.error('revocation deletion failed', {
        reason: event.reason,
        message: error instanceof Error ? error.message : String(error),
      })
      this.#notify(() => this.#onError(error), event, 'onError')
    }
  }

  /**
   * Delivers to a caller-supplied sink without letting it poison the queue. A
   * sink that throws is recorded and logged — the failure stays observable — but
   * it does not reject the run, so the next `auth_revoked` still reaches the
   * handler.
   */
  #notify(deliver: () => void, event: AuthRevokedEvent, stage: 'onResult' | 'onError'): void {
    try {
      deliver()
    } catch (sinkError) {
      this.#failures.push({ reason: event.reason, at: event.at, stage, error: sinkError })
      this.#logger.error('revocation sink threw', {
        reason: event.reason,
        stage,
        message: sinkError instanceof Error ? sinkError.message : String(sinkError),
      })
    }
  }
}

/** Refuses a missing or non-callable sink, including from a plain-JS caller. */
function requireSink(value: unknown, name: string): void {
  if (typeof value !== 'function') {
    throw new TypeError(
      `${name} is required: a §12.4 deletion result must not be able to disappear because a callback was not wired`,
    )
  }
}
