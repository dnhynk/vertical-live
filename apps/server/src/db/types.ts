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

/**
 * One envelope on its way into the inbox, plus what a storage-boundary filter
 * did to it.
 *
 * `commitIngestBatch` also accepts a bare `IngestEnvelope`, which means "nothing
 * was filtered" — every caller that has nothing to declare stays unchanged.
 */
export interface InboxSubmission {
  readonly envelope: IngestEnvelope
  /**
   * A `command.argument` outside the storable vocabulary was removed before this
   * write (T8). Persisted as a flag; the removed token is never stored anywhere
   * (spec §12.3).
   */
  readonly argumentRejected?: boolean
}

export type InboxInput = IngestEnvelope | InboxSubmission

/** An inbox row handed to the single writer for processing (spec §7.3(3)). */
export interface InboxRow {
  readonly ingestSeq: number
  readonly validationStatus: ValidationStatus
  readonly receivedAt: string
  readonly envelope: IngestEnvelope
  /** True when a storage-boundary filter removed this row's command argument. */
  readonly argumentRejected: boolean
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
  /**
   * The writer's own domain state, serialized with the snapshot in the same
   * transaction (T8). The store treats it as opaque JSON: the read model in
   * `snapshot` cannot rebuild a content director, and a second transaction would
   * leave a crash window where the cursor has passed inputs this state never
   * saw. Omitting it stores `NULL` — the value is replaced, never merged.
   */
  readonly engineState?: unknown
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

export type EffectMarkResult =
  'recorded' | 'already_published' | 'already_acked' | 'already_expired'

/** spec §9.3, BOARD A-4: `single` is production, rolling is a labelled experiment. */
export type BroadcastStrategy = 'single' | 'rolling-experiment'

/**
 * Monotonic stage of *our* work on one broadcast attempt (spec §9.1). It is not
 * YouTube's `lifeCycleStatus`: this is what the server durably did, that is what
 * YouTube reports, and reconcile compares the two.
 */
export type BroadcastStage =
  | 'planned'
  | 'stream_ready'
  | 'broadcast_created'
  | 'bound'
  | 'testing'
  | 'live'
  | 'complete'
  | 'abandoned'

/** Stage order used to reject a stage that would move backwards. */
export const BROADCAST_STAGE_ORDER: readonly BroadcastStage[] = Object.freeze([
  'planned',
  'stream_ready',
  'broadcast_created',
  'bound',
  'testing',
  'live',
  'complete',
])

/**
 * The mutating calls whose outcome can be uncertain. Reads are never recorded as
 * pending: re-reading is always safe, and reconcile itself is a read.
 */
export type BroadcastMutatingCall =
  | 'liveStreams.insert'
  | 'liveBroadcasts.insert'
  | 'liveBroadcasts.bind'
  | 'liveBroadcasts.transition'
  | 'liveBroadcasts.update'

/**
 * `liveBroadcasts.transition` targets. Persisted with the pending call because the
 * observed `lifeCycleStatus` alone does not say whether a transition was applied:
 * `complete` confirms a stop and refutes a go-live (review round 1, B4).
 */
export type BroadcastTransitionTarget = 'testing' | 'live' | 'complete'

export interface BroadcastAttemptInput {
  /** Locally generated: the YouTube write methods carry no idempotency key. */
  readonly attemptId: string
  readonly strategy: BroadcastStrategy
  /** Reuse/reconcile key of the ingestion stream. */
  readonly streamTitle: string
  /** Corroborating reconcile key of the broadcast; chosen before `insert` is called. */
  readonly scheduledStartTime: string
  /**
   * The product-owned identity of this attempt, carried in the broadcast's
   * description and written here before `insert` is called. It is what a reconcile
   * matches on: a scheduled time alone is not an identity (review round 2, B1).
   */
  readonly attemptMarker: string
}

/** One persisted broadcast attempt (`broadcast_resources`). */
export interface BroadcastAttemptRecord extends BroadcastAttemptInput {
  readonly stage: BroadcastStage
  /** Non-null means the result of that call is unknown (spec §9.1). */
  readonly pendingCall: BroadcastMutatingCall | null
  /** Set exactly when `pendingCall` is the transition. */
  readonly pendingTransition: BroadcastTransitionTarget | null
  readonly pendingSince: string | null
  readonly streamId: string | null
  readonly broadcastId: string | null
  readonly liveChatId: string | null
  /** null = not attempted, true = accepted, false = `invalidAutoStart` (§4). */
  readonly autoStart: boolean | null
  readonly lastErrorReason: string | null
  /** Set once the attempt marker is no longer in the description (BOARD A-18). */
  readonly markerClearedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly closedAt: string | null
}

/**
 * What one resolved call adds to the attempt. Every field is optional so a caller
 * records exactly what it learned; `stage` may only move forwards.
 */
export interface BroadcastAttemptUpdate {
  readonly stage?: BroadcastStage
  readonly streamId?: string
  readonly broadcastId?: string
  readonly liveChatId?: string
  readonly scheduledStartTime?: string
  readonly autoStart?: boolean
  /** Stamps `markerClearedAt` with the store clock; never unsets it. */
  readonly markerCleared?: true
  /** `null` clears a previously recorded reason. */
  readonly lastErrorReason?: string | null
}

/** What a restart needs before it resumes source reception (spec §7.3(3), §11). */
export interface RecoveryState {
  /** `null` before the first state commit. */
  readonly snapshot: WorldSnapshot | null
  readonly stateRevision: number
  readonly processedIngestSeq: number
  /** Whatever the writer stored as `StateTransitionInput.engineState`. */
  readonly engineState: unknown
  /** Committed effects that are neither acked nor expired (spec §7.3(7)). */
  readonly unackedEffects: readonly PersistedEffect[]
  /** Pending deadlines already due at the recovery instant (spec §10.2). */
  readonly dueDeadlines: readonly PersistedDeadline[]
  readonly checkpoints: readonly SourceCheckpoint[]
}
