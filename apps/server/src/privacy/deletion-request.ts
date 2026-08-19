import type { Clock } from '../clock.js'
import type { PersistenceStore } from '../db/index.js'
import type { ConsentSelector } from '../db/types.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import { CONSENT_FIELD_KEY, type RetentionConfig } from './config.js'
import { CONSENT_TABLE, findIdentityColumns, findIdentitySchemaText } from './identity-columns.js'
import { plusDays } from './retention.js'

/**
 * User / account deletion request handler (spec §12.4: "사용자 삭제·계정 삭제
 * 요청은 해당 사용자와 관련해 저장한 모든 user data를 가능한 빨리, 최대 7일 안에
 * 삭제한다").
 *
 * The handler answers a request in one of two ways, and which one is not a
 * configuration choice — it follows from what the request names:
 *
 * - **No identifier** (the closed configuration of BOARD A-1, and any request
 *   from someone who never consented): there is nothing stored about anybody, and
 *   the honest implementation of that is not "do nothing" but to **prove** it from
 *   the live schema and leave a dated audit record.
 * - **A `channelRef` or a `channelId`** (BOARD D-9): the one `viewer_consent` row
 *   is deleted immediately, well inside the 7 days §12.4 allows, and the
 *   `retention_ledger` row is committed in the same transaction.
 *
 * An identifier that is passed in is used and discarded: it is never stored
 * outside the row it deletes and never written to a log line — the receipt and
 * the audit row carry counts, not names. The schema audit still runs in both
 * cases, because an identity column *outside* the consent table would mean this
 * handler cannot promise it deleted everything (spec §12.4).
 */

export class IdentityColumnsPresentError extends Error {
  readonly columns: readonly string[]

  constructor(columns: readonly string[]) {
    super(
      `the schema stores identity-shaped columns outside ${CONSENT_TABLE} (${columns.join(', ')}), so a user deletion request cannot be answered by this handler: deleting the consent row would not delete everything (spec §12.4, BOARD D-9)`,
    )
    this.name = 'IdentityColumnsPresentError'
    this.columns = columns
  }
}

export interface UserDeletionRequestOptions {
  readonly store: PersistenceStore
  readonly clock: Clock
  readonly config: RetentionConfig
  readonly logger?: Logger
}

export interface UserDeletionReceipt {
  /** When the request was accepted (defaults to the injected clock). */
  readonly receivedAt: string
  /** `receivedAt + revocation.userRequestDeletionDays` (spec §12.4). */
  readonly deadlineAt: string
  /**
   * Identity columns found **outside** the consent table. Always empty — the
   * handler throws when it is not — so this is the proof, not a claim.
   */
  readonly storedIdentifierColumns: readonly string[]
  /** 1 when a consent row was deleted, 0 when nothing was stored (BOARD D-9). */
  readonly rowsDeleted: number
  readonly ledgerEntryId: number
  readonly recordedAt: string
}

/**
 * What the operator was given by the person making the request. Either
 * reference addresses exactly one consent row; omit it entirely when the request
 * names nobody the system could have stored.
 */
export type UserDeletionSubject = ConsentSelector

/** Ledger key for a request, distinguished from the `table.field` field keys. */
export const USER_DELETION_FIELD_KEY = 'request.user_data'

export class UserDeletionRequestHandler {
  readonly #store: PersistenceStore
  readonly #clock: Clock
  readonly #config: RetentionConfig
  readonly #logger: Logger

  constructor(options: UserDeletionRequestOptions) {
    this.#store = options.store
    this.#clock = options.clock
    this.#config = options.config
    this.#logger = options.logger ?? silentLogger
  }

  /**
   * Answers one request. `subject` is the reference the requester gave the
   * operator, or nothing at all when they gave none (see the module comment).
   *
   * Throws `IdentityColumnsPresentError` when some table other than
   * `viewer_consent` has somewhere to store a person: deleting the consent row
   * would then not be the whole answer, and recording that it was would be a
   * false audit record.
   */
  handle(
    subject?: UserDeletionSubject,
    receivedAt: string = this.#clock.nowUtcIso(),
  ): UserDeletionReceipt {
    const columnHits = findIdentityColumns(this.#store)
    const textHits = findIdentitySchemaText(this.#store)
    const offenders = [
      ...columnHits.map((hit) => `${hit.table}.${hit.column}`),
      ...textHits.map((hit) => `${hit.object} (${hit.matched})`),
    ]
    if (offenders.length > 0) {
      throw new IdentityColumnsPresentError(offenders)
    }

    const deadlineAt = plusDays(receivedAt, this.#config.revocation.userRequestDeletionDays)
    const allowedPeriodDays = this.#config.revocation.userRequestDeletionDays
    if (subject !== undefined && this.#store.hasTable(CONSENT_TABLE)) {
      const recordedAt = this.#clock.nowUtcIso()
      const result = this.#store.deleteConsent(subject, ({ rowsDeleted }) => ({
        fieldKey: CONSENT_FIELD_KEY,
        source: 'youtube_api',
        purpose:
          'user or account deletion request: the consented viewer identity of BOARD D-9, deleted immediately (spec §12.4 최대 7일, [S41] III.E.4.g)',
        policy: 'delete',
        reason: 'user_request',
        allowedPeriodDays,
        cutoffAt: null,
        deadlineAt,
        outcome: rowsDeleted > 0 ? 'deleted' : 'no_stored_identifiers',
        rowsDeleted,
        rowsUnprocessed: 0,
        deletedAt: rowsDeleted > 0 ? recordedAt : null,
        recordedAt,
      }))
      // Counts only: naming the subject here is exactly what the module refuses
      // to do (spec §12.4, §12.3).
      this.#logger.info('user deletion request completed', {
        deadlineAt,
        rowsDeleted: result.rowsDeleted,
      })
      return {
        receivedAt,
        deadlineAt,
        storedIdentifierColumns: [],
        rowsDeleted: result.rowsDeleted,
        ledgerEntryId: result.ledgerEntryId,
        recordedAt,
      }
    }

    const recordedAt = this.#clock.nowUtcIso()
    const ledgerEntryId = this.#store.recordRetention({
      fieldKey: USER_DELETION_FIELD_KEY,
      source: 'youtube_api',
      purpose:
        'user or account deletion request: confirmed from the live schema that no user data is stored for this request (spec §12.4)',
      policy: 'delete',
      reason: 'user_request',
      allowedPeriodDays,
      cutoffAt: null,
      deadlineAt,
      outcome: 'no_stored_identifiers',
      rowsDeleted: 0,
      rowsUnprocessed: 0,
      deletedAt: null,
      recordedAt,
    })
    this.#logger.info('user deletion request recorded', { deadlineAt, storedIdentifiers: 0 })

    return {
      receivedAt,
      deadlineAt,
      storedIdentifierColumns: [],
      rowsDeleted: 0,
      ledgerEntryId,
      recordedAt,
    }
  }
}
