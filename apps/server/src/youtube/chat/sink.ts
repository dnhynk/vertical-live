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
 */

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

    const envelopes: IngestEnvelope[] = []
    let dropped = 0
    let userEvents = 0
    for (const item of batch.items) {
      let envelope: IngestEnvelope
      try {
        envelope = adapt(item, context)
      } catch {
        // An adapter that throws is a bug, not an input shape; the batch must
        // still commit so the checkpoint advances past this response.
        dropped += 1
        continue
      }
      if (!IngestEnvelopeSchema.safeParse(envelope).success) {
        dropped += 1
        continue
      }
      if (envelope.validationStatus === 'valid') userEvents += 1
      envelopes.push(envelope)
    }

    // Committed even when `envelopes` is empty: a heartbeat response with a new
    // token still has to move the checkpoint, or a reconnect would replay from
    // an older point.
    const token = batch.nextPageToken === null || batch.nextPageToken === '' ? null : batch.nextPageToken
    const result = this.#options.inbox.ingest(envelopes, {
      sourceKey: this.#options.sourceKey,
      liveChatId: this.#options.liveChatId,
      nextPageToken: token ?? this.#pageToken,
    })
    this.#pageToken = result.checkpoint.nextPageToken
    if (result.insertedCount > 0) this.#options.onIngested?.(result.insertedCount)

    return {
      accepted: envelopes.length,
      inserted: result.insertedCount,
      duplicates: result.duplicateCount,
      dropped,
      lastIngestSeq: result.lastIngestSeq,
      checkpoint: result.checkpoint,
      userEvents,
      userEventAt: userEvents > 0 ? receivedAt : null,
    }
  }
}
