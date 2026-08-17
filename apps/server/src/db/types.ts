import type {
  DeadlinePolicy,
  Effect,
  IngestEnvelope,
  PaidEventKind,
  ValidationStatus,
  WorldSnapshot,
} from '@vl/contract'

/**
 * Public record shapes of the persistence layer. Column names are snake_case in
 * SQL and camelCase here; the mapping happens in `store.ts` only.
 */

/** Reconnect token state for one source stream (spec §7.3(2)). */
export interface SourceCheckpointInput {
  /** Stable key of the source stream, e.g. `youtube:{liveChatId}`. */
  readonly sourceKey: string
  readonly liveChatId: string
  /** `nextPageToken` from the last response; `null` before the first one. */
  readonly nextPageToken: string | null
}

export interface SourceCheckpoint extends SourceCheckpointInput {
  readonly lastIngestSeq: number
  readonly updatedAt: string
}

/** Outcome of one envelope in a `commitIngestBatch` call, in input order. */
export interface IngestInsertResult {
  readonly ingestSeq: number
  readonly messageId: string | null
  /** True when this exact event key was already in the inbox (spec §7.3(4)). */
  readonly duplicate: boolean
}

export interface IngestBatchResult {
  readonly results: readonly IngestInsertResult[]
  readonly insertedCount: number
  readonly duplicateCount: number
  /** Highest `ingest_seq` this source has reached, after the batch. */
  readonly lastIngestSeq: number
  readonly checkpoint: SourceCheckpoint
}

/** An inbox row handed to the single writer for processing (spec §7.3(3)). */
export interface InboxRow {
  readonly ingestSeq: number
  readonly validationStatus: ValidationStatus
  readonly receivedAt: string
  readonly envelope: IngestEnvelope
}

/** One committed transition of the authoritative state (spec §7.3(5)). */
export interface StateTransitionRecord {
  readonly revision: number
  /** `null` for a timer or system transition no external event caused. */
  readonly causedByEventKey: string | null
  readonly kind: string
  readonly at: string
}

/**
 * Why an inbox row is done. Invalid and unsupported rows advance with a reason
 * instead of blocking the drain (spec §7.3(3)).
 */
export interface InboxProcessingRecord {
  readonly ingestSeq: number
  readonly result: string
  /** Defaults to the store clock's current instant. */
  readonly at?: string
}

export type DeadlineStatus = 'pending' | 'fired' | 'expired' | 'cancelled'

/** An absolute UTC deadline plus its downtime policy (spec §10.2). */
export interface DeadlineRecord {
  readonly id: string
  readonly kind: string
  readonly dueAt: string
  readonly policy: DeadlinePolicy
  /** Serialized with `JSON.stringify`; must not contain unserializable values. */
  readonly payload: unknown
  readonly status: DeadlineStatus
}

/** A deadline read back from the store. Same shape; the payload is re-parsed. */
export type PersistedDeadline = DeadlineRecord

/** A paid audit row. The event key is the idempotency unit (spec §11 유료 무결성). */
export interface PaidLedgerRecord {
  readonly eventKey: string
  readonly kind: PaidEventKind
  readonly amountMicros: number | null
  readonly currency: string | null
  readonly tier: number | null
  readonly jewels: number | null
  readonly appliedAt: string
}

/** A gift combo step to fold into the stored maximum (spec §7.4). */
export interface GiftComboRequest {
  /** Event key without the `:gift:{effectiveCount}` suffix. */
  readonly baseKey: string
  readonly effectiveCount: number
}

export interface GiftDelta extends GiftComboRequest {
  readonly previousMax: number
  readonly storedMax: number
  /** `max(0, effectiveCount - previousMax)`: what the world should apply. */
  readonly delta: number
}

/**
 * Everything one state transition confirms, committed in a single transaction
 * (spec §7.3(5)). Optional arrays default to empty.
 */
export interface StateTransitionInput {
  readonly snapshot: WorldSnapshot
  readonly revision: number
  readonly processedSeq: number
  readonly transitions?: readonly StateTransitionRecord[]
  readonly processed?: readonly InboxProcessingRecord[]
  readonly deadlines?: readonly DeadlineRecord[]
  readonly effects?: readonly Effect[]
  readonly paidLedger?: readonly PaidLedgerRecord[]
  readonly giftCombo?: readonly GiftComboRequest[]
}

export interface StateTransitionResult {
  readonly stateRevision: number
  readonly processedIngestSeq: number
  readonly giftDeltas: readonly GiftDelta[]
  /** Effect ids written by this commit. */
  readonly effectsInserted: readonly string[]
  /** Effect ids already in the outbox, left untouched (idempotent replay). */
  readonly effectsDuplicate: readonly string[]
  readonly paidLedgerInserted: readonly string[]
  /** Paid event keys already in the ledger, left untouched (spec §11). */
  readonly paidLedgerDuplicate: readonly string[]
}

/** An outbox row rebuilt into the renderer contract plus its ACK bookkeeping. */
export interface PersistedEffect {
  readonly effect: Effect
  readonly publishedAt: string | null
  readonly ackedAt: string | null
  readonly expiredAt: string | null
}

export type EffectMarkResult = 'recorded' | 'already_published' | 'already_acked' | 'already_expired'

/** What a restart needs before it resumes source reception (spec §7.3(3), §11). */
export interface RecoveryState {
  /** `null` before the first state commit. */
  readonly snapshot: WorldSnapshot | null
  readonly stateRevision: number
  readonly processedIngestSeq: number
  /** Committed effects that are neither acked nor expired (spec §7.3(7)). */
  readonly unackedEffects: readonly PersistedEffect[]
  /** Pending deadlines already due at the recovery instant (spec §10.2). */
  readonly dueDeadlines: readonly PersistedDeadline[]
  readonly checkpoints: readonly SourceCheckpoint[]
}
