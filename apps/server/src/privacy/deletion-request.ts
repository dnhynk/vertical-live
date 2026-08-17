import type { Clock } from '../clock.js'
import type { PersistenceStore } from '../db/index.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { RetentionConfig } from './config.js'
import { findIdentityColumns, findIdentitySchemaText } from './identity-columns.js'
import { plusDays } from './retention.js'

/**
 * User / account deletion request handler (spec §12.4: "사용자 삭제·계정 삭제
 * 요청은 해당 사용자와 관련해 저장한 모든 user data를 가능한 빨리, 최대 7일 안에
 * 삭제한다").
 *
 * While the identity gate is closed there is nothing to delete, and the honest
 * implementation of that is not "do nothing": it is to **prove** it from the live
 * schema and leave a dated audit record. That is what this handler does, and it is
 * the interface the gated path will replace once identity is approved.
 *
 * `handle` takes **no identifier at all** — no channel id, no name, no opaque
 * token for the requester. Accepting one would mean either storing it (which is
 * exactly what §12.4 forbids) or holding it long enough to log it. The receipt is
 * returned to the caller, who is the operator answering the request; only the
 * identifier-free fact that a request was handled is persisted.
 */

export class IdentityColumnsPresentError extends Error {
  readonly columns: readonly string[]

  constructor(columns: readonly string[]) {
    super(
      `the schema stores identity-shaped columns (${columns.join(', ')}), so a user deletion request cannot be answered by this handler; the identity gate opened without the gated deletion path (spec §12.4, §17, BOARD A-1)`,
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
  /** Always empty while the identity gate is closed; the proof, not a claim. */
  readonly storedIdentifierColumns: readonly string[]
  readonly rowsDeleted: 0
  readonly ledgerEntryId: number
  readonly recordedAt: string
}

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
   * Answers one request. Takes no identifier by design (see the module comment).
   *
   * Throws `IdentityColumnsPresentError` when the schema has somewhere to store a
   * person after all: at that point the request is a real deletion job and
   * silently recording "nothing stored" would be a false audit record.
   */
  handle(receivedAt: string = this.#clock.nowUtcIso()): UserDeletionReceipt {
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
    const recordedAt = this.#clock.nowUtcIso()
    const ledgerEntryId = this.#store.recordRetention({
      fieldKey: USER_DELETION_FIELD_KEY,
      source: 'youtube_api',
      purpose:
        'user or account deletion request: confirmed from the live schema that no user data is stored (spec §12.4)',
      policy: 'delete',
      reason: 'user_request',
      allowedPeriodDays: this.#config.revocation.userRequestDeletionDays,
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
