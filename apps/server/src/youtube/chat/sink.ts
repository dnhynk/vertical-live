import {
  IngestEnvelopeSchema,
  fromGrpcStreamListItem,
  fromRestListItem,
  type CommandParser,
  type IngestAdapterContext,
  type IngestEnvelope,
} from '@vl/contract'

import type { Clock } from '../../clock.js'
import type { InboxWriter } from '../../engine/ingest.js'
import type { SourceCheckpoint } from '../../db/types.js'

/**
 * The one write path from a YouTube response into the world (spec §7.3(2)).
 *
 * Both sources — gRPC `streamList` and the REST `list` fallback — hand their
 * raw items here. The sink
 *
 * 1. normalizes every item with the adapter of *its own* shape (§7.2: the two
 *    field vocabularies are never mixed),
 * 2. re-validates each envelope against the contract schema,
 * 3. commits the whole response **and** the reconnect token in one
 *    `commitIngestBatch` transaction (§7.3(2)).
 *
 * Step 2 is what makes "a poison item never stalls the checkpoint" true rather
 * than hoped for. The adapters already turn a malformed item into a minimal
 * `invalid` envelope instead of throwing, so in the normal case nothing is
 * dropped; but `commitIngestBatch` parses every envelope inside its transaction,
 * so a single envelope the schema rejects would roll back the *whole* batch,
 * the checkpoint with it, and the next reconnect would fetch the same poison
 * item forever. Dropping that one item (counted, never silently) keeps the
 * stream moving, which is the behaviour §7.3(2) asks for.
 *
 * The checkpoint only ever moves forward to a token the server actually sent:
 * an empty `next_page_token` leaves the last good token in place, because that
 * is the token a reconnect must present.
 *
 * The consent gate adds one step and no field. When it is open, each raw item is
 * shown to the `ConsentDirectory` **inside the inbox transaction, and only for an
 * envelope that transaction actually inserted** (`IngestCommitHooks`), because
 * the raw item is the only thing that still carries `authorDetails` — the
 * envelope never has a field for it. The directory writes or deletes the one
 * consent row and remembers a consented viewer's name in memory; nothing it saw
 * is added to the envelope, so the inbox is byte-for-byte what it was while the
 * gate was closed (BOARD D-9, spec §7.4).
 *
 * Putting it on the inbox's own idempotency boundary is not tidiness. A
 * duplicate page or a reconnect replays the same `messageId`s; run consent
 * before the dedupe and a replayed `JOIN` **revives** an identity its `LEAVE`
 * already deleted, with a fresh `channelRef` (review round 1, B1). The dedupe
 * decides once, and the consent decision follows it.
 */

/**
 * The consent side of one received item (T20b). Kept as a one-method port so the
 * sink depends on the decision, not on the store behind it, and so the closed
 * configuration simply passes nothing.
 */
export interface ConsentObserver {
  observe(rawItem: unknown, envelope: IngestEnvelope): { readonly kind: string }
}

/**
 * Which consent decision could not be applied. `withdrawal` is the one the
 * server refuses to commit past (see `ConsentObserveError`); the other two are
 * counted and reported.
 */
export type ConsentFailureKind = 'withdrawal' | 'join' | 'message'

export interface ConsentFailure {
  readonly kind: ConsentFailureKind
}

/**
 * A `LEAVE` whose consent mutation threw, raised out of the ingest transaction
 * so the batch — rows *and* checkpoint — rolls back (review round 1, B3).
 *
 * **Withdrawal and deletion are fail-closed.** The earlier version counted the
 * failure and committed anyway, which retired the checkpoint past the withdrawal:
 * the command was never retried, and the identity stayed until the 30-day sweep.
 * Committing the rows without the deletion would be just as wrong now that the
 * consent decision follows the inbox dedupe — the replayed items would be
 * duplicates, so the decision would be skipped a second time (B1). Rolling back
 * puts the same items back in front of the same token, and the retry applies the
 * deletion.
 *
 * The cost is the deliberate one: while the consent store keeps failing this
 * source stops advancing. That is visible — `consecutiveFailures`,
 * `retryBudgetExhausted` and the consent signal on `/health`, the
 * `consent_observe_failed_*` counters on `/metrics` — and it is the trade §12.4
 * asks for, because the alternative is a viewer who asked to be deleted and was
 * not.
 *
 * A `JOIN` is **not** fail-closed: nothing was stored, which is the safe side of
 * this decision, and the viewer can send it again (ticket §Review round 1).
 */
export class ConsentObserveError extends Error {
  constructor(cause: unknown) {
    super(
      `a LEAVE (consent withdrawal) could not be applied, so the batch and its checkpoint were rolled back rather than skipping the deletion (spec §12.4): ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'ConsentObserveError'
    this.cause = cause
  }
}

export interface ChatIngestSinkOptions {
  /** `StateEngine.ingest` — inbox rows and checkpoint in one transaction. */
  readonly inbox: InboxWriter
  readonly clock: Clock
  /** T6 command parser port; only free chat text is ever offered to it. */
  readonly parseCommand: CommandParser
  /** Checkpoint key shared by both shapes, e.g. `youtube:{liveChatId}`. */
  readonly sourceKey: string
  readonly liveChatId: string
  readonly broadcastId: string
  /** Token restored from the store at start-up (spec §7.3(2)). */
  readonly initialPageToken?: string | null
  /** Called after a commit so the engine's writer loop stops idling. */
  readonly onIngested?: (insertedCount: number) => void
  /**
   * Consent directory, present only while the consent gate is open (BOARD D-9).
   * Absent means the request carried no `authorDetails` part at all, so there is
   * nothing for it to read.
   */
  readonly consent?: ConsentObserver
  /**
   * Called for every consent decision that could not be applied, before the
   * batch is rolled back or committed. It carries a kind and nothing else — the
   * sink never learns whose decision it was — and it is what puts the failure on
   * `/health` and `/metrics` instead of leaving it in a return value nobody
   * reads (review round 1, B3).
   */
  readonly onConsentFailure?: (failure: ConsentFailure) => void
}

export interface ChatBatch {
  readonly sourceShape: 'grpc' | 'rest'
  readonly items: readonly unknown[]
  /** `next_page_token` / `nextPageToken` of this response, if any. */
  readonly nextPageToken: string | null
}

export interface ChatBatchOutcome {
  readonly accepted: number
  readonly inserted: number
  /** Items already in the inbox — the reconnect duplicate estimate (spec §11). */
  readonly duplicates: number
  /** Items the contract schema rejected; counted, never hidden. */
  readonly dropped: number
  readonly lastIngestSeq: number
  readonly checkpoint: SourceCheckpoint
  /** Valid (supported) user events in this batch — the §9.4(3) counter. */
  readonly userEvents: number
  /** `receivedAt` of this batch when it carried at least one valid user event. */
  readonly userEventAt: string | null
  /**
   * Consent decisions this batch carried: `JOIN`s recorded and `LEAVE`s honoured
   * (BOARD D-9). Anonymous counts — the sink never learns whose they were.
   */
  readonly consentJoined: number
  readonly consentLeft: number
  /**
   * Consent decisions this batch could not apply. A failed `LEAVE` never reaches
   * this field — it throws `ConsentObserveError` and there is no outcome at all,
   * which is the point of fail-closed withdrawal (review round 1, B3).
   */
  readonly consentFailed: number
}

/** One item of an API response, as its shape's adapter reads it. */
export type ChatItemAdapter = (item: unknown, context: IngestAdapterContext) => IngestEnvelope

/**
 * An envelope and the raw item it was made of, kept together until the write.
 *
 * The pair exists because the consent decision now happens inside the inbox
 * transaction: the raw item — the only carrier of `authorDetails` — has to
 * survive until the row it belongs to has been inserted, and no further.
 */
export interface NormalizedChatItem {
  readonly item: unknown
  readonly envelope: IngestEnvelope
}

export interface NormalizedChatItems {
  readonly entries: NormalizedChatItem[]
  /** Items no envelope could be made of. Reported, never silently swallowed. */
  readonly dropped: number
  /** Valid (supported) events among them. */
  readonly userEvents: number
}

/**
 * Items → envelopes, with the two guards that keep one bad item from stopping
 * the stream: a throwing adapter and an envelope the contract schema would
 * reject inside `commitIngestBatch`'s transaction. Neither should ever happen —
 * the adapters are written to return a minimal `invalid` envelope instead — and
 * that is exactly why the failure mode has to be "drop and count", not "retry
 * this response forever" (spec §7.3(2)).
 *
 * No consent decision is made here any more: it belongs to the transaction that
 * inserts the row, so this keeps the raw item next to its envelope and hands the
 * pair to `commit` (review round 1, B1).
 */
export function normalizeChatItems(
  items: readonly unknown[],
  adapt: ChatItemAdapter,
  context: IngestAdapterContext,
): NormalizedChatItems {
  const entries: NormalizedChatItem[] = []
  let dropped = 0
  let userEvents = 0
  for (const item of items) {
    let envelope: IngestEnvelope
    try {
      envelope = adapt(item, context)
    } catch {
      dropped += 1
      continue
    }
    if (!IngestEnvelopeSchema.safeParse(envelope).success) {
      dropped += 1
      continue
    }
    if (envelope.validationStatus === 'valid') userEvents += 1
    entries.push({ item, envelope })
  }
  return { entries, dropped, userEvents }
}

export class ChatIngestSink {
  readonly #options: ChatIngestSinkOptions
  #pageToken: string | null

  constructor(options: ChatIngestSinkOptions) {
    this.#options = options
    this.#pageToken = options.initialPageToken ?? null
  }

  /** The token a (re)connect must present, or `null` for a cold start. */
  get pageToken(): string | null {
    return this.#pageToken
  }

  get sourceKey(): string {
    return this.#options.sourceKey
  }

  /**
   * Forgets the in-memory resume token after the server refused it. The stored
   * checkpoint keeps the old value until the next commit replaces it with a
   * fresh one: a token that is merely unusable is still better evidence of
   * where we were than `null`, and the caller reports the gap as unknown
   * (spec §11).
   */
  forgetPageToken(): void {
    this.#pageToken = null
  }

  commit(batch: ChatBatch): ChatBatchOutcome {
    const receivedAt = this.#options.clock.nowUtcIso()
    const context: IngestAdapterContext = {
      broadcastId: this.#options.broadcastId,
      liveChatId: this.#options.liveChatId,
      receivedAt,
      parseCommand: this.#options.parseCommand,
    }
    const adapt = batch.sourceShape === 'grpc' ? fromGrpcStreamListItem : fromRestListItem
    const { entries, dropped, userEvents } = normalizeChatItems(batch.items, adapt, context)

    let consentJoined = 0
    let consentLeft = 0
    let consentFailed = 0
    const consent = this.#options.consent
    // Runs inside `commitIngestBatch`'s transaction, once per envelope that
    // transaction inserted (never for a duplicate), with the raw item that
    // produced it still in scope — the last moment `authorDetails` exists
    // (BOARD D-9). A throw here rolls the batch back; see `ConsentObserveError`.
    const onInserted = (_envelope: IngestEnvelope, index: number): void => {
      const entry = entries[index]
      if (consent === undefined || entry === undefined) return
      try {
        const observation = consent.observe(entry.item, entry.envelope)
        if (observation.kind === 'joined') consentJoined += 1
        if (observation.kind === 'left') consentLeft += 1
      } catch (error) {
        consentFailed += 1
        const kind = consentFailureKind(entry.envelope)
        this.#options.onConsentFailure?.({ kind })
        if (kind === 'withdrawal') throw new ConsentObserveError(error)
      }
    }

    // Committed even when `entries` is empty: a heartbeat response with a new
    // token still has to move the checkpoint, or a reconnect would replay from
    // an older point.
    const token =
      batch.nextPageToken === null || batch.nextPageToken === '' ? null : batch.nextPageToken
    const result = this.#options.inbox.ingest(
      entries.map((entry) => entry.envelope),
      {
        sourceKey: this.#options.sourceKey,
        liveChatId: this.#options.liveChatId,
        nextPageToken: token ?? this.#pageToken,
      },
      consent === undefined ? {} : { onInserted },
    )
    this.#pageToken = result.checkpoint.nextPageToken
    if (result.insertedCount > 0) this.#options.onIngested?.(result.insertedCount)

    return {
      accepted: entries.length,
      inserted: result.insertedCount,
      duplicates: result.duplicateCount,
      dropped,
      lastIngestSeq: result.lastIngestSeq,
      checkpoint: result.checkpoint,
      userEvents,
      userEventAt: userEvents > 0 ? receivedAt : null,
      consentJoined,
      consentLeft,
      consentFailed,
    }
  }
}

/** Which decision the failed observation was about, read off the envelope. */
function consentFailureKind(envelope: IngestEnvelope): ConsentFailureKind {
  // Only a valid envelope has a `consentCommand` slot at all; an invalid one
  // never carried a decision, so its failure is a message-path failure.
  const name =
    envelope.validationStatus === 'valid' ? (envelope.consentCommand?.name ?? null) : null
  if (name === 'LEAVE') return 'withdrawal'
  if (name === 'JOIN') return 'join'
  return 'message'
}
