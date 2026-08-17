import type { Clock } from '../clock.js'
import type { PersistenceStore, RetentionOutcome, RetentionReason } from '../db/index.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { SecretVault } from '../secrets/vault.js'
import type { AuthEvent, AuthEventSink, AuthRevokedEvent } from '../youtube/auth/events.js'
import { REFRESH_TOKEN_SECRET } from '../youtube/auth/token-manager.js'
import type { RetentionConfig, RetentionField, RevocationClass } from './config.js'
import { plusDays } from './retention.js'

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
  readonly logger?: Logger
}

export interface RevocationEntryResult {
  readonly fieldKey: string
  readonly table: string
  readonly outcome: RetentionOutcome
  readonly rowsDeleted: number
  readonly rowsUnprocessed: number
  readonly truncated: boolean
  readonly ledgerEntryId: number
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
  readonly #logger: Logger

  constructor(options: RevocationHandlerOptions) {
    this.#store = options.store
    this.#clock = options.clock
    this.#config = options.config
    this.#grantRevoker = options.grantRevoker
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

    const entries = this.authorizedFields.map((field) =>
      this.#deleteField(field, { reason, allowedPeriodDays, deadlineAt }),
    )
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

  #deleteField(
    field: RetentionField,
    context: { reason: RetentionReason; allowedPeriodDays: number; deadlineAt: string },
  ): RevocationEntryResult {
    // The whole table goes, not just the expired part: the consent that allowed
    // this data is gone, so its age no longer matters (spec §12.4).
    let swept: { rowsDeleted: number; rowsUnprocessed: number; truncated: boolean }
    try {
      swept = this.#store.deleteAllRows({
        table: field.table,
        batchLimit: this.#config.sweep.batchLimit,
        maxBatches: this.#config.sweep.maxBatchesPerEntry,
        unfinishedColumn: field.unfinishedColumn,
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
        ledgerEntryId: this.#record(field, context, {
          outcome: 'failed',
          rowsDeleted: 0,
          rowsUnprocessed: 0,
        }),
        error: message,
      }
    }

    const outcome: RetentionOutcome = swept.rowsDeleted > 0 ? 'deleted' : 'nothing_expired'
    return {
      fieldKey: field.key,
      table: field.table,
      outcome,
      rowsDeleted: swept.rowsDeleted,
      rowsUnprocessed: swept.rowsUnprocessed,
      truncated: swept.truncated,
      ledgerEntryId: this.#record(field, context, {
        outcome,
        rowsDeleted: swept.rowsDeleted,
        rowsUnprocessed: swept.rowsUnprocessed,
      }),
    }
  }

  #record(
    field: RetentionField,
    context: { reason: RetentionReason; allowedPeriodDays: number; deadlineAt: string },
    swept: { outcome: RetentionOutcome; rowsDeleted: number; rowsUnprocessed: number },
  ): number {
    return this.#store.recordRetention({
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
    })
  }
}

/**
 * Adapts the async handler to T3's synchronous `AuthEventSink`, so T12 can wire
 * revocation-driven deletion by handing this sink to the `TokenManager`.
 *
 * `emit` cannot await, so the run is tracked on `pending`: tests await it, and
 * production code hands `onError` to the alert sink. A rejected deletion is never
 * dropped on the floor — that would leave a §12.4 obligation unrecorded.
 */
export class RevocationAuthEventSink implements AuthEventSink {
  readonly #handler: RevocationHandler
  readonly #onResult: ((result: RevocationResult) => void) | undefined
  readonly #onError: (error: unknown) => void
  #pending: Promise<void> = Promise.resolve()

  constructor(options: {
    handler: RevocationHandler
    onResult?: (result: RevocationResult) => void
    onError?: (error: unknown) => void
  }) {
    this.#handler = options.handler
    this.#onResult = options.onResult
    this.#onError =
      options.onError ??
      (() => {
        // Default: swallow nothing silently — the handler already logs, and a
        // caller that wants alerts passes `onError`.
      })
  }

  /** Resolves when every revocation started so far has finished. */
  get pending(): Promise<void> {
    return this.#pending
  }

  emit(event: AuthEvent): void {
    if (event.type !== 'auth_revoked') return
    this.#pending = this.#pending.then(async () => {
      try {
        const result = await this.#handler.handle(event)
        this.#onResult?.(result)
      } catch (error) {
        this.#onError(error)
      }
    })
  }
}
