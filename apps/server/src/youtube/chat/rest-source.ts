import type { Clock } from '../../clock.js'
import { silentLogger, type Logger } from '../../secrets/redaction.js'
import { AuthRevokedError } from '../auth/token-manager.js'
import { decideRetry, type BackoffPolicy } from '../quota/backoff.js'
import { classifyYouTubeApiError } from '../quota/classify.js'
import type { QuotaTracker } from '../quota/tracker.js'
import type { ChatConfig } from './config.js'
import {
  CancellableDelay,
  createChatBackoff,
  type ChatAccessTokens,
  type ChatRunResult,
} from './retry.js'
import type { ChatIngestSink } from './sink.js'
import type { ChatSourceState } from './state.js'

/**
 * `liveChatMessages.list` fallback (spec §4: "REST `list`는 서버가 준 polling
 * 간격을 지키는 fallback이다").
 *
 * Two rules make this a fallback rather than a second primary path:
 *
 * 1. **The server sets the pace.** `pollingIntervalMillis` is "the amount of
 *    time, in milliseconds, that the client should wait before polling again"
 *    ([S3], checked 2026-08-17) and is obeyed as given, only clamped into
 *    `[minPollIntervalMs, maxPollIntervalMs]` so a missing or absurd value
 *    cannot turn into a hot loop or an hour of silence. Polling faster is what
 *    earns `rateLimitExceeded` ("The request was sent too quickly after the
 *    previous request").
 * 2. **The checkpoint is shared.** It reads and writes the same
 *    `youtube:{liveChatId}` row through the same sink as the gRPC path, so a
 *    switch in either direction resumes where the other left off (§7.3(2)).
 *
 * Each call is charged to the quota tracker (T3) before it is made, because a
 * poll loop is the one part of this product that can spend a day's units.
 */

export interface RestChatSourceOptions {
  readonly sink: ChatIngestSink
  readonly state: ChatSourceState
  readonly clock: Clock
  readonly config: ChatConfig
  readonly auth: ChatAccessTokens
  readonly liveChatId: string
  readonly quota?: QuotaTracker
  readonly logger?: Logger
  /** Injected in tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
  readonly random?: () => number
}

interface RestResponseBody {
  readonly items?: readonly unknown[]
  readonly nextPageToken?: string
  readonly pollingIntervalMillis?: number
  readonly offlineAt?: string
}

export class RestChatSource {
  readonly #options: RestChatSourceOptions
  readonly #policy: BackoffPolicy
  readonly #delay: CancellableDelay
  readonly #logger: Logger
  readonly #fetch: typeof fetch

  #cancelled = false
  #abort: AbortController | undefined
  #refreshedForAuth = false
  /** Monotonic instant at which the primary path may be tried again. */
  #switchBackAtMs = 0

  constructor(options: RestChatSourceOptions) {
    this.#options = options
    this.#policy = createChatBackoff(options.config.reconnect, options.random)
    this.#delay = new CancellableDelay(options.clock)
    this.#logger = options.logger ?? silentLogger
    this.#fetch = options.fetchImpl ?? fetch
  }

  stop(): void {
    this.#cancelled = true
    this.#abort?.abort()
    this.#delay.cancel()
  }

  async run(): Promise<ChatRunResult> {
    const { state, config, clock } = this.#options
    state.setMode('rest')
    this.#cancelled = false
    this.#refreshedForAuth = false
    this.#switchBackAtMs = clock.monotonicMs() + config.fallback.retryPrimaryAfterMs

    while (!this.#cancelled) {
      if (clock.monotonicMs() >= this.#switchBackAtMs) {
        return { outcome: 'switch_back', reason: 'retry_primary' }
      }

      let accessToken: string
      try {
        accessToken = await this.#options.auth.getAccessToken()
      } catch (error) {
        if (error instanceof AuthRevokedError) {
          state.recordStop('auth_revoked')
          return { outcome: 'stopped', reason: 'auth_revoked' }
        }
        state.recordFailure(
          { kind: 'network', action: 'retry', retryable: true, reason: 'token_refresh_failed' },
          config.reconnect.maxAttempts,
        )
        await this.#backoff()
        continue
      }

      const pageToken = this.#options.sink.pageToken
      state.connectAttempt(pageToken !== null)
      const result = await this.#poll(accessToken, pageToken)
      if (this.#cancelled) return { outcome: 'cancelled', reason: 'stop_requested' }
      if (result !== null) return result
    }
    return { outcome: 'cancelled', reason: 'stop_requested' }
  }

  /** One request. Returns a run result when the loop must end, else `null`. */
  async #poll(accessToken: string, pageToken: string | null): Promise<ChatRunResult | null> {
    const { config, state } = this.#options
    const url = new URL(config.rest.baseUrl)
    url.searchParams.set('liveChatId', this.#options.liveChatId)
    // `id,snippet` only — the REST path never asks for `authorDetails` either
    // (spec §7.2).
    url.searchParams.set('part', config.parts.join(','))
    url.searchParams.set('maxResults', String(config.maxResults))
    if (pageToken !== null) url.searchParams.set('pageToken', pageToken)

    this.#options.quota?.record('liveChatMessages.list')

    const abort = new AbortController()
    this.#abort = abort
    const timeout = this.#options.clock.setTimeout(() => {
      abort.abort()
    }, config.rest.requestTimeoutMs)

    let status = 0
    let body: unknown
    let retryAfter: string | undefined
    try {
      const response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        signal: abort.signal,
      })
      status = response.status
      retryAfter = response.headers.get('retry-after') ?? undefined
      body = await response.json().catch(() => undefined)
    } catch (error) {
      const code = this.#cancelled ? 'ECONNRESET' : errorCode(error)
      state.recordFailure(
        classifyYouTubeApiError({ errorCode: code }),
        config.reconnect.maxAttempts,
      )
      await this.#backoff()
      return null
    } finally {
      this.#options.clock.clearTimeout(timeout)
      this.#abort = undefined
    }

    if (status < 200 || status >= 300) {
      return this.#handleError(status, body, retryAfter)
    }

    const parsed = (body ?? {}) as RestResponseBody
    state.recordResponse()
    try {
      const outcome = this.#options.sink.commit({
        sourceShape: 'rest',
        items: parsed.items ?? [],
        nextPageToken: parsed.nextPageToken ?? null,
      })
      state.recordCommit(outcome)
      if (outcome.dropped > 0) {
        this.#logger.warn('youtube chat: dropped item(s) the contract schema refused', {
          shape: 'rest',
          dropped: outcome.dropped,
        })
      }
    } catch (error) {
      this.#logger.error('youtube chat: ingest commit failed; retrying from last token', {
        error: (error as Error).message,
      })
      state.recordFailure(
        { kind: 'unknown', action: 'retry', retryable: true, reason: 'ingest_failed' },
        config.reconnect.maxAttempts,
      )
      await this.#backoff()
      return null
    }
    if (parsed.offlineAt !== undefined) state.recordOffline(parsed.offlineAt)

    await this.#delay.wait(this.pollDelayMs(parsed.pollingIntervalMillis))
    return null
  }

  /** The server's interval, clamped into the configured bounds (spec §4). */
  pollDelayMs(serverIntervalMs: number | undefined): number {
    const { minPollIntervalMs, maxPollIntervalMs } = this.#options.config.rest
    if (
      serverIntervalMs === undefined ||
      !Number.isFinite(serverIntervalMs) ||
      serverIntervalMs < 0
    ) {
      return minPollIntervalMs
    }
    return Math.min(maxPollIntervalMs, Math.max(minPollIntervalMs, Math.round(serverIntervalMs)))
  }

  async #handleError(
    status: number,
    body: unknown,
    retryAfter: string | undefined,
  ): Promise<ChatRunResult | null> {
    const { state, config } = this.#options
    const classification = classifyYouTubeApiError({
      httpStatus: status,
      body,
      retryAfterHeader: retryAfter,
      nowMs: Date.parse(this.#options.clock.nowUtcIso()),
    })
    state.recordFailure(classification, config.reconnect.maxAttempts)

    if (
      (classification.kind === 'invalidRequest' || classification.kind === 'notFound') &&
      this.#options.sink.pageToken !== null &&
      status === 400
    ) {
      this.#logger.warn('youtube chat: resume token refused; polling without one')
      this.#options.sink.forgetPageToken()
      state.recordTokenRejected()
      return null
    }

    if (classification.kind === 'unauthorized' || classification.kind === 'forbidden') {
      const stopReason =
        classification.kind === 'unauthorized' ? 'unauthenticated' : 'permission_denied'
      // A 403 with a `liveChatDisabled`/`liveChatEnded` reason is classified as
      // `failedPrecondition`, so reaching here means a real permission problem.
      if (this.#refreshedForAuth) {
        state.recordStop(stopReason)
        return { outcome: 'stopped', reason: stopReason }
      }
      this.#refreshedForAuth = true
      try {
        await this.#options.auth.forceRefresh()
        return null
      } catch (error) {
        const reason = error instanceof AuthRevokedError ? 'auth_revoked' : stopReason
        state.recordStop(reason)
        return { outcome: 'stopped', reason }
      }
    }

    if (!classification.retryable) {
      state.recordStop(classification.kind)
      return { outcome: 'stopped', reason: classification.kind }
    }

    const decision = decideRetry({
      classification,
      attempt: Math.max(1, state.consecutiveFailures),
      policy: this.#policy,
      ...(this.#options.quota === undefined
        ? {}
        : { msUntilQuotaReset: this.#options.quota.msUntilReset() }),
    })
    await this.#delay.wait(decision.retry ? decision.delayMs : config.reconnect.maxDelayMs)
    return null
  }

  async #backoff(): Promise<void> {
    const { state, config } = this.#options
    const decision = decideRetry({
      classification: { kind: 'serverError', action: 'retry', retryable: true },
      attempt: Math.max(1, state.consecutiveFailures),
      policy: this.#policy,
    })
    await this.#delay.wait(decision.retry ? decision.delayMs : config.reconnect.maxDelayMs)
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown; cause?: { code?: unknown } })?.code
  if (typeof code === 'string') return code
  const causeCode = (error as { cause?: { code?: unknown } })?.cause?.code
  return typeof causeCode === 'string' ? causeCode : 'UND_ERR_SOCKET'
}
