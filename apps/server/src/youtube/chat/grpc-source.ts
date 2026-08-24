import type { ServiceError } from '@grpc/grpc-js'

import type { Clock } from '../../clock.js'
import { silentLogger, type Logger } from '../../secrets/redaction.js'
import { AuthRevokedError } from '../auth/token-manager.js'
import { decideRetry, type BackoffPolicy } from '../quota/backoff.js'
import { classifyYouTubeApiError } from '../quota/classify.js'
import type { QuotaTracker } from '../quota/tracker.js'
import type { ChatConfig } from './config.js'
import type { ChatReconnectWaitReason } from './health.js'
import {
  CancellableDelay,
  createChatBackoff,
  type ChatAccessTokens,
  type ChatRunResult,
} from './retry.js'
import type { ChatIngestSink } from './sink.js'
import type { ChatSourceState } from './state.js'
import type { StreamListCall, StreamListResponse, StreamListTransport } from './transport.js'

/**
 * `liveChatMessages.streamList` reader — the low-latency production path
 * (spec §4, §7.2).
 *
 * One "connection" is one server-streaming call. Every response it delivers is
 * committed immediately (items + reconnect token in one transaction, §7.3(2)),
 * so the resume point is durable before the next response is even parsed. When
 * the call ends or fails, the loop reconnects with the last token, exactly as
 * the official guide prescribes: "If your client disconnects, you can use this
 * token to resume the stream."
 *
 * gRPC status handling (codes from the streamList reference, checked
 * 2026-08-17) goes through T3's shared classifier so the fault matrix of
 * spec §11 has one table, not two:
 *
 * | status | classified as | this loop does |
 * |---|---|---|
 * | `UNAVAILABLE`/`INTERNAL`/`DEADLINE_EXCEEDED` | `serverError` | reconnect with backoff |
 * | `RESOURCE_EXHAUSTED` | `rateLimitExceeded` | reconnect with backoff (the reference calls it "sent too quickly") |
 * | `UNAUTHENTICATED` | `unauthorized` | one T3 token refresh, then retry; `AuthRevokedError` stops the source |
 * | `PERMISSION_DENIED` | `forbidden` | one refresh in case the grant was merely stale, then stop — scope/consent needs a human (§9.1) |
 * | `INVALID_ARGUMENT` | `invalidRequest` | if a resume token was presented, drop it, record the gap as unknown (§11) and retry once without it; otherwise stop |
 * | `NOT_FOUND`/`FAILED_PRECONDITION` | `notFound`/`failedPrecondition` | stop: the chat is gone, disabled or ended, and only a new `liveChatId` helps |
 *
 * A clean end of stream is not a failure and never counts toward the fallback
 * threshold: the server is entitled to close a long-lived call.
 */

export interface GrpcChatSourceOptions {
  readonly transport: StreamListTransport
  readonly sink: ChatIngestSink
  readonly state: ChatSourceState
  readonly clock: Clock
  readonly config: ChatConfig
  readonly auth: ChatAccessTokens
  readonly liveChatId: string
  /** T3's day-unit accounting; one connection is one `streamList` call. */
  readonly quota?: QuotaTracker
  readonly logger?: Logger
  /** Injected in tests so backoff delays are reproducible (CLAUDE.md §4). */
  readonly random?: () => number
  /** Shared across retargeted sessions so changing chat cannot bypass T47 pacing. */
  readonly startPacingState?: GrpcStartPacingState
}

export interface GrpcStartPacingState {
  lastStartedAtMonotonicMs: number | null
}

interface ConnectionEnd {
  readonly kind: 'end' | 'error'
  readonly error?: ServiceError
  readonly responses: number
}

type TokenAttempt = { ok: true; token: string } | { ok: false; revoked: boolean }

export class GrpcChatSource {
  readonly #options: GrpcChatSourceOptions
  readonly #policy: BackoffPolicy
  readonly #delay: CancellableDelay
  readonly #logger: Logger
  readonly #startPacingState: GrpcStartPacingState

  #cancelled = false
  #call: StreamListCall | undefined
  #commitError: Error | undefined
  #emptyEnds = 0
  #refreshedForAuth = false

  constructor(options: GrpcChatSourceOptions) {
    this.#options = options
    this.#policy = createChatBackoff(options.config.reconnect, options.random)
    this.#delay = new CancellableDelay(options.clock)
    this.#logger = options.logger ?? silentLogger
    this.#startPacingState = options.startPacingState ?? { lastStartedAtMonotonicMs: null }
  }

  /** Channel connectivity for the keepalive signal (spec §9.4(3)). */
  channelState(): string {
    return this.#options.transport.channelState()
  }

  stop(): void {
    this.#cancelled = true
    this.#call?.cancel()
    this.#delay.cancel()
  }

  async run(): Promise<ChatRunResult> {
    const { state, config } = this.#options
    state.setMode('grpc')
    this.#cancelled = false
    this.#refreshedForAuth = false

    while (!this.#cancelled) {
      const token = await this.#accessToken()
      if (!token.ok) {
        if (token.revoked) return { outcome: 'stopped', reason: 'auth_revoked' }
        // Not revocation — the refresh call itself failed. Back off and retry:
        // a network blip must not end chat ingestion.
        state.recordFailure(
          { kind: 'network', action: 'retry', retryable: true, reason: 'token_refresh_failed' },
          config.reconnect.maxAttempts,
        )
        await this.#backoff()
        continue
      }

      await this.#paceNextStart()
      if (this.#cancelled) break

      const pageToken = this.#options.sink.pageToken
      state.connectAttempt(pageToken !== null)
      const ended = await this.#connect(token.token, pageToken)
      state.recordDisconnect()
      if (this.#cancelled) return { outcome: 'cancelled', reason: 'stop_requested' }

      const next = await this.#afterConnection(ended)
      if (next !== null) return next
      if (state.consecutiveFailures >= config.fallback.enterAfterConsecutiveFailures) {
        return { outcome: 'fallback', reason: 'grpc_consecutive_failures' }
      }
    }
    return { outcome: 'cancelled', reason: 'stop_requested' }
  }

  async #accessToken(): Promise<TokenAttempt> {
    try {
      return { ok: true, token: await this.#options.auth.getAccessToken() }
    } catch (error) {
      if (error instanceof AuthRevokedError) {
        this.#options.state.recordStop('auth_revoked')
        return { ok: false, revoked: true }
      }
      this.#logger.warn('youtube chat: access token unavailable', {
        error: (error as Error).message,
      })
      return { ok: false, revoked: false }
    }
  }

  #connect(accessToken: string, pageToken: string | null): Promise<ConnectionEnd> {
    const { config, liveChatId } = this.#options
    const request = {
      live_chat_id: liveChatId,
      // `id,snippet` only — `authorDetails` is never requested (spec §7.2).
      part: config.parts,
      max_results: config.maxResults,
      ...(pageToken === null ? {} : { page_token: pageToken }),
    }
    this.#commitError = undefined
    const startedAtMonotonicMs = this.#options.clock.monotonicMs()
    this.#startPacingState.lastStartedAtMonotonicMs = startedAtMonotonicMs
    this.#options.quota?.record('liveChatMessages.streamList')

    return new Promise<ConnectionEnd>((resolve) => {
      let responses = 0
      let settled = false
      const settle = (end: ConnectionEnd): void => {
        if (settled) return
        settled = true
        this.#call = undefined
        resolve(end)
      }

      const call = this.#options.transport.open(request, accessToken)
      this.#call = call
      call.onData((response) => {
        responses += 1
        this.#options.state.recordResponse()
        try {
          this.#handle(response)
        } catch (error) {
          // A failed commit must not be swallowed: stop reading, then let the
          // loop reconnect from the last durable token so nothing is lost.
          this.#commitError = error as Error
          call.cancel()
        }
      })
      call.onError((error) => {
        settle({ kind: 'error', error, responses })
      })
      call.onEnd(() => {
        settle({ kind: 'end', responses })
      })
    })
  }

  #handle(response: StreamListResponse): void {
    const outcome = this.#options.sink.commit({
      sourceShape: 'grpc',
      items: response.items ?? [],
      nextPageToken: response.next_page_token ?? null,
    })
    this.#options.state.recordCommit(outcome)
    if (response.offline_at !== undefined) {
      this.#options.state.recordOffline(response.offline_at)
    }
    if (outcome.dropped > 0) {
      this.#logger.warn('youtube chat: dropped item(s) the contract schema refused', {
        shape: 'grpc',
        dropped: outcome.dropped,
      })
    }
  }

  /** Returns a run result when the loop must end, or `null` to keep going. */
  async #afterConnection(ended: ConnectionEnd): Promise<ChatRunResult | null> {
    const { state, config } = this.#options

    if (this.#commitError !== undefined) {
      const message = this.#commitError.message
      this.#commitError = undefined
      this.#logger.error('youtube chat: ingest commit failed; reconnecting from last token', {
        error: message,
      })
      state.recordFailure(
        { kind: 'unknown', action: 'retry', retryable: true, reason: 'ingest_failed' },
        config.reconnect.maxAttempts,
      )
      await this.#backoff()
      return null
    }

    if (ended.kind === 'end') {
      if (ended.responses > 0) {
        // A healthy close resumes from the durable token. The quota-safe floor
        // is enforced at the one boundary shared by every next actual start.
        this.#emptyEnds = 0
        return null
      }
      this.#emptyEnds += 1
      await this.#wait('empty_end_backoff', this.#policy.nextDelayMs(Math.min(this.#emptyEnds, 8)))
      return null
    }

    this.#emptyEnds = 0
    const error = ended.error
    const classification = classifyYouTubeApiError({
      ...(error === undefined ? {} : { grpcCode: error.code }),
      nowMs: Date.parse(this.#options.clock.nowUtcIso()),
    })
    state.recordFailure(classification, config.reconnect.maxAttempts)

    if (classification.kind === 'invalidRequest' && this.#options.sink.pageToken !== null) {
      // The most likely invalid argument is a resume token the server no longer
      // accepts. Drop it, admit the gap is unbounded (§11) and reconnect cold.
      this.#logger.warn('youtube chat: resume token refused; reconnecting without one')
      this.#options.sink.forgetPageToken()
      state.recordTokenRejected()
      return null
    }

    if (classification.kind === 'unauthorized' || classification.kind === 'forbidden') {
      const stopReason =
        classification.kind === 'unauthorized' ? 'unauthenticated' : 'permission_denied'
      if (this.#refreshedForAuth) {
        state.recordStop(stopReason)
        return { outcome: 'stopped', reason: stopReason }
      }
      this.#refreshedForAuth = true
      try {
        await this.#options.auth.forceRefresh()
        return null
      } catch (refreshError) {
        const reason = refreshError instanceof AuthRevokedError ? 'auth_revoked' : stopReason
        state.recordStop(reason)
        return { outcome: 'stopped', reason }
      }
    }

    if (!classification.retryable) {
      state.recordStop(classification.kind)
      return { outcome: 'stopped', reason: classification.kind }
    }

    await this.#backoff()
    return null
  }

  async #backoff(): Promise<void> {
    const { state, config } = this.#options
    const decision = decideRetry({
      classification: { kind: 'serverError', action: 'retry', retryable: true },
      attempt: Math.max(1, state.consecutiveFailures),
      policy: this.#policy,
    })
    // Past the attempt budget the source keeps trying at the maximum delay: a
    // chat reader that gave up would end unattended operation (spec §2.1). The
    // exhausted budget is what turns the transport signal `degraded` (§9.4(3)).
    await this.#wait(
      'failure_backoff',
      decision.retry ? decision.delayMs : config.reconnect.maxDelayMs,
    )
  }

  /**
   * Hard quota floor for every actual `streamList` start. Branch-specific
   * backoffs run first; this adds only the remaining time since the prior start.
   */
  async #paceNextStart(): Promise<void> {
    const lastStartedAt = this.#startPacingState.lastStartedAtMonotonicMs
    if (lastStartedAt === null) return
    const elapsedMs = this.#options.clock.monotonicMs() - lastStartedAt
    const remainingMs = Math.max(0, this.#options.config.grpcStreamMinStartIntervalMs - elapsedMs)
    await this.#wait('quota_start_pacing', remainingMs)
  }

  async #wait(reason: ChatReconnectWaitReason, delayMs: number): Promise<void> {
    if (delayMs <= 0) return
    this.#options.state.recordReconnectWait(reason, delayMs)
    try {
      await this.#delay.wait(delayMs)
    } finally {
      this.#options.state.clearReconnectWait()
    }
  }
}
