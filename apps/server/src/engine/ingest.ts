import { timingSafeEqual } from 'node:crypto'

import { IngestEnvelopeSchema, type IngestEnvelope } from '@vl/contract'

import type { IngestBatchResult, SourceCheckpointInput } from '../db/types.js'

/**
 * `POST /ingest/simulator` (TASK_SPECS 공통 규약, §T8, §T11).
 *
 * Four refusals, in this order, because each one is a different kind of "no":
 *
 * 1. **404 while `simulator.enabled` is false.** A production broadcast must not
 *    even admit that a synthetic input path exists (§T11 acceptance 3).
 * 2. **403 off loopback.** Every surface of this server is loopback-bound
 *    (spec §10.2); the check is here as well as in the listener bind.
 * 3. **401 without the vault bearer token.** The token lives in the vault (T3),
 *    never in the repository, the config file or a log (spec §10.2).
 * 4. **400 for anything the envelope schema rejects.** A malformed body does not
 *    reach the inbox, and the response says which index failed and why in
 *    contract vocabulary only — never an echo of the body (spec §12.3).
 *
 * Accepted envelopes go through the engine's `ingest()`, i.e. the same
 * `commitIngestBatch` transaction the YouTube adapter will use: rows and
 * checkpoint together (spec §7.3(2)). The source label stays `simulator`, which
 * is what keeps synthetic participation distinguishable from real participation
 * (spec §2.6).
 *
 * The checkpoint is **derived, never accepted**. An authenticated caller could
 * otherwise name any `sourceKey` and overwrite the live YouTube reconnect token
 * with a synthetic one, which would lose real messages on the next reconnect
 * (R-T8-1 major 1). The key is `simulator:{liveChatId}` of the batch itself, and a
 * batch that mixes chats is refused rather than silently attributed to one.
 */

/** The inbox write path (`StateEngine.ingest`), injected so this stays testable. */
export interface InboxWriter {
  ingest(envelopes: readonly IngestEnvelope[], checkpoint: SourceCheckpointInput): IngestBatchResult
}

export interface SimulatorIngestOptions {
  readonly inbox: InboxWriter
  /** `simulator.enabled` from `config/default.json`. */
  readonly enabled: boolean
  /** `server.simulatorToken` from the vault; `null` when it is not configured. */
  readonly token: string | null
  /** Called after a successful commit so the writer loop stops idling. */
  readonly onIngested?: (count: number) => void
}

export interface SimulatorIngestRequest {
  readonly authorization: string | null
  readonly remoteAddress: string | null
  readonly body: unknown
}

export interface SimulatorIngestResponse {
  readonly status: number
  readonly body: unknown
}

export class SimulatorIngestEndpoint {
  readonly #options: SimulatorIngestOptions

  constructor(options: SimulatorIngestOptions) {
    this.#options = options
  }

  get enabled(): boolean {
    return this.#options.enabled
  }

  handle(request: SimulatorIngestRequest): SimulatorIngestResponse {
    if (!this.#options.enabled) return { status: 404, body: { error: 'not_found' } }
    if (!isLoopbackAddress(request.remoteAddress)) {
      return { status: 403, body: { error: 'loopback_only' } }
    }
    if (!this.#authorized(request.authorization)) {
      return { status: 401, body: { error: 'unauthorized' } }
    }

    const parsed = parseBody(request.body)
    if ('error' in parsed) return { status: 400, body: parsed }

    const result = this.#options.inbox.ingest(parsed.envelopes, parsed.checkpoint)
    this.#options.onIngested?.(result.insertedCount)
    return {
      status: 202,
      body: {
        accepted: result.results.length,
        inserted: result.insertedCount,
        duplicates: result.duplicateCount,
        lastIngestSeq: result.lastIngestSeq,
      },
    }
  }

  #authorized(authorization: string | null): boolean {
    const expected = this.#options.token
    // No token configured is a closed door, not an open one.
    if (expected === null || expected === '') return false
    const prefix = 'Bearer '
    if (authorization === null || !authorization.startsWith(prefix)) return false
    const presented = Buffer.from(authorization.slice(prefix.length))
    const secret = Buffer.from(expected)
    if (presented.length !== secret.length) return false
    return timingSafeEqual(presented, secret)
  }
}

interface ParsedBody {
  readonly envelopes: IngestEnvelope[]
  readonly checkpoint: SourceCheckpointInput
}

interface BodyError {
  readonly error: string
  readonly index?: number
  readonly field?: string
}

function parseBody(body: unknown): ParsedBody | BodyError {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'body_must_be_an_object' }
  }
  const record = body as Record<string, unknown>
  const rawEnvelopes = record['envelopes']
  if (!Array.isArray(rawEnvelopes) || rawEnvelopes.length === 0) {
    return { error: 'envelopes_must_be_a_non_empty_array' }
  }

  const envelopes: IngestEnvelope[] = []
  for (const [index, raw] of rawEnvelopes.entries()) {
    const parsed = IngestEnvelopeSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return {
        error: 'invalid_envelope',
        index,
        field: issue === undefined ? 'unknown' : issue.path.join('.'),
      }
    }
    if (parsed.data.source !== 'simulator' || parsed.data.sourceShape !== 'simulator') {
      // Spec §2.6: synthetic input may not present itself as real participation.
      return { error: 'source_must_be_simulator', index }
    }
    envelopes.push(parsed.data)
  }

  const first = envelopes[0] as IngestEnvelope
  // One batch, one chat: the checkpoint it advances has to be the checkpoint of
  // the messages it carries, and a mixed batch has no single answer.
  if (envelopes.some((envelope) => envelope.liveChatId !== first.liveChatId)) {
    return { error: 'batch_must_share_one_live_chat_id' }
  }

  const derived: SourceCheckpointInput = {
    sourceKey: simulatorSourceKey(first.liveChatId),
    liveChatId: first.liveChatId,
    nextPageToken: null,
  }

  const rawCheckpoint = record['checkpoint']
  if (rawCheckpoint === undefined) return { envelopes, checkpoint: derived }
  if (typeof rawCheckpoint !== 'object' || rawCheckpoint === null || Array.isArray(rawCheckpoint)) {
    return { error: 'checkpoint_must_be_an_object' }
  }
  const checkpoint = rawCheckpoint as Record<string, unknown>
  const sourceKey = checkpoint['sourceKey'] ?? derived.sourceKey
  const liveChatId = checkpoint['liveChatId'] ?? derived.liveChatId
  const nextPageToken = checkpoint['nextPageToken'] ?? null
  if (typeof nextPageToken !== 'string' && nextPageToken !== null) {
    return { error: 'checkpoint_nextPageToken_must_be_a_string_or_null' }
  }
  // The caller may repeat what the batch already says; it may not name anything
  // else. Refusing is better than silently rewriting: a simulator run that meant
  // to advance a real checkpoint should fail loudly (spec §2.6, §7.3(2)).
  if (liveChatId !== derived.liveChatId) {
    return { error: 'checkpoint_live_chat_id_must_match_the_batch' }
  }
  if (sourceKey !== derived.sourceKey) {
    return { error: 'checkpoint_source_key_must_be_the_simulator_namespace' }
  }
  return { envelopes, checkpoint: { ...derived, nextPageToken } }
}

/**
 * The only checkpoint key a simulator batch can ever touch. The `simulator:`
 * prefix is what keeps it disjoint from the `youtube:{liveChatId}` keys the real
 * source owns (TASK_SPECS §T4 `SourceCheckpointInput`).
 */
export function simulatorSourceKey(liveChatId: string): string {
  return `simulator:${liveChatId}`
}

export function isLoopbackAddress(address: string | null): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
