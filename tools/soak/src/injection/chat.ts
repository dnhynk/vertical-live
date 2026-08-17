import {
  buildChatHealthSignals,
  classifyYouTubeApiError,
  loadChatConfig,
  type ApiErrorClassification,
  type Clock,
  type HealthSignal,
} from '@vl/server'
import type { ChatPort } from '@vl/server/supervisor'

/**
 * The chat input path under fault injection (spec §11 rows "API 403·429와 quota
 * 고갈", "DNS 단절"; §9.4(3)).
 *
 * Each fault is expressed the way YouTube expresses it — an HTTP status plus the
 * `reason` code from the Live Streaming reference, or a Node transport error code
 * — and handed to the **production** classifier. `classifyYouTubeApiError` decides
 * `retry` / `degraded` / `safe_stopped`; this class only acts on that decision the
 * way T9's source does:
 *
 * - `retry`: keep the failure counted, stay disconnected, try again next poll;
 * - `degraded`: stop calling YouTube and say why (`quota_exhausted`), because the
 *   day's units only come back at the Pacific midnight reset;
 * - `safe_stopped`: hand the reason to the supervisor, which stops the run.
 *
 * The §9.4(3) signals are built by the production `buildChatHealthSignals`, so
 * the aggregator sees the real four signal names and the real reason tokens.
 */

export interface ChatFault {
  readonly httpStatus?: number
  readonly reason?: string
  /** Node transport error code, e.g. `ENOTFOUND` for the DNS row. */
  readonly errorCode?: string
  /** How many polls fail before the fault clears on its own; `null` = forever. */
  readonly polls: number | null
}

export interface FaultyChatOptions {
  readonly clock: Clock
  /** Called when a classified failure means the run must stop (spec §9.1). */
  readonly onSafeStop: (reason: string, detail: Record<string, string | number>) => void
}

export class FaultyChat {
  readonly #clock: Clock
  readonly #onSafeStop: (reason: string, detail: Record<string, string | number>) => void
  readonly #keepalive = loadChatConfig().grpc.keepalive

  #started = false
  #connected = false
  #fault: ChatFault | null = null
  #remainingPolls = 0
  #consecutiveFailures = 0
  #stopped: { reason: string; at: string } | null = null
  #lastError: ApiErrorClassification | null = null
  #lastErrorAt: string | null = null
  #lastResponseAtUtc: string | null = null
  #lastResponseAtMonotonicMs: number | null = null
  #reconnects = 0
  #userEvents = 0
  #lastUserEventAtUtc: string | null = null
  #lastUserEventAtMonotonicMs: number | null = null

  /** Restart attempts the supervisor drove, for the §10.2 one-owner assertions. */
  restarts = 0

  constructor(options: FaultyChatOptions) {
    this.#clock = options.clock
    this.#onSafeStop = options.onSafeStop
  }

  get started(): boolean {
    return this.#started
  }

  get connected(): boolean {
    return this.#connected
  }

  get lastClassification(): ApiErrorClassification | null {
    return this.#lastError
  }

  // ------------------------------------------------------------ fault control

  /** Injects a failure the source will meet on its next poll. */
  fail(fault: ChatFault): void {
    this.#fault = fault
    this.#remainingPolls = fault.polls ?? Number.POSITIVE_INFINITY
  }

  clearFault(): void {
    this.#fault = null
    this.#remainingPolls = 0
    this.#stopped = null
  }

  /** A synthetic user event arrived, for §9.4(3)'s "마지막 사용자 이벤트 시각". */
  noteUserEvent(): void {
    this.#userEvents += 1
    this.#lastUserEventAtUtc = this.#clock.nowUtcIso()
    this.#lastUserEventAtMonotonicMs = this.#clock.monotonicMs()
  }

  // -------------------------------------------------------------------- ports

  get port(): ChatPort {
    return {
      start: () => {
        this.start()
      },
      started: () => this.#started && this.#stopped === null,
    }
  }

  start(): void {
    this.#started = true
    this.#stopped = null
    this.poll()
  }

  /** `ComponentActions.chatSource`: stop, then start again unless the run stopped. */
  readonly restart = async (signal: AbortSignal): Promise<void> => {
    this.restarts += 1
    this.#started = false
    this.#connected = false
    await Promise.resolve()
    if (signal.aborted) return
    this.start()
  }

  /**
   * One poll of the source. Either it delivers (connected, response recorded) or
   * it meets the injected failure and reacts to the *classified* action.
   */
  poll(): void {
    if (!this.#started) return
    if (this.#stopped !== null) return

    if (this.#fault !== null && this.#remainingPolls > 0) {
      this.#remainingPolls -= 1
      const classification = classifyYouTubeApiError({
        ...(this.#fault.httpStatus === undefined ? {} : { httpStatus: this.#fault.httpStatus }),
        ...(this.#fault.errorCode === undefined ? {} : { errorCode: this.#fault.errorCode }),
        ...(this.#fault.reason === undefined
          ? {}
          : { body: { error: { errors: [{ reason: this.#fault.reason }] } } }),
      })
      this.#lastError = classification
      this.#lastErrorAt = this.#clock.nowUtcIso()
      this.#consecutiveFailures += 1
      this.#connected = false
      if (this.#remainingPolls <= 0) this.#fault = null

      switch (classification.action) {
        case 'safe_stopped':
          this.#stopped = { reason: `api_${classification.kind}`, at: this.#lastErrorAt }
          this.#onSafeStop(`youtube_api:${classification.kind}`, {
            kind: classification.kind,
            httpStatus: classification.httpStatus ?? 0,
          })
          return
        case 'degraded':
          // Nothing a retry can fix before the reset, so the source stops
          // calling YouTube and says so (spec §9.1). The world keeps running.
          this.#stopped = { reason: `api_${classification.kind}`, at: this.#lastErrorAt }
          return
        case 'retry':
          return
      }
      return
    }

    const wasDown = !this.#connected
    this.#connected = true
    this.#consecutiveFailures = 0
    this.#lastResponseAtUtc = this.#clock.nowUtcIso()
    this.#lastResponseAtMonotonicMs = this.#clock.monotonicMs()
    if (wasDown && this.#reconnectsPossible) this.#reconnects += 1
  }

  get #reconnectsPossible(): boolean {
    return this.#lastResponseAtUtc !== null
  }

  // ------------------------------------------------------------------ signals

  signals(): readonly HealthSignal[] {
    return buildChatHealthSignals(
      {
        mode: this.#started ? 'grpc' : 'idle',
        connected: this.#connected,
        channelState: this.#connected ? 'READY' : this.#started ? 'TRANSIENT_FAILURE' : null,
        keepalive: this.#keepalive,
        lastResponseAtUtc: this.#lastResponseAtUtc,
        lastResponseAtMonotonicMs: this.#lastResponseAtMonotonicMs,
        consecutiveFailures: this.#consecutiveFailures,
        retryBudgetExhausted: false,
        lastError:
          this.#lastError === null || this.#lastErrorAt === null
            ? null
            : {
                kind: this.#lastError.kind,
                action: this.#lastError.action,
                at: this.#lastErrorAt,
                statusCode: this.#lastError.httpStatus ?? null,
                reason: this.#lastError.reason ?? null,
              },
        offlineAt: null,
        stopped: this.#stopped,
        reconnect: {
          count: this.#reconnects,
          lastAt: this.#reconnects > 0 ? this.#lastResponseAtUtc : null,
          gapMs: null,
          resumedWithToken: this.#reconnects > 0 ? true : null,
          tokenRejected: false,
          reconnectsWithoutToken: 0,
          estimatedDuplicates: 0,
          estimatedLostMessages: this.#reconnects > 0 ? 0 : null,
        },
        // A pagination cursor, never a credential (spec §9.4(3)).
        pageToken: this.#lastResponseAtUtc === null ? null : 'sim_page_token',
        userEvents: {
          lastAtUtc: this.#lastUserEventAtUtc,
          lastAtMonotonicMs: this.#lastUserEventAtMonotonicMs,
          total: this.#userEvents,
        },
      },
      this.#clock,
    )
  }
}
