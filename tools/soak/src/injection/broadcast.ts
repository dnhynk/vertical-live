import {
  classifyYouTubeApiError,
  deriveBroadcastHealthSignals,
  type Clock,
  type HealthSignal,
  type LiveStreamStatus,
} from '@vl/server'
import type { BroadcastPort } from '@vl/server/supervisor'

/**
 * The broadcast lifecycle under fault injection (spec §11 rows "API 403", §9.4(6)).
 *
 * Like the chat fake, it expresses a failure the way YouTube does and lets the
 * production `classifyYouTubeApiError` decide what it means; a `safe_stopped`
 * classification is handed to the supervisor through the same
 * `SafeStopRequestSink` shape T10 uses, so the drill exercises the real wiring
 * rather than calling `requestSafeStop` directly.
 *
 * The §9.4(6) signals come from the production `deriveBroadcastHealthSignals`.
 */

export interface BroadcastFault {
  readonly httpStatus: number
  readonly reason?: string
  /** How many calls fail before it clears; `null` = forever. */
  readonly calls: number | null
}

export interface FaultyBroadcastOptions {
  readonly clock: Clock
  readonly onSafeStop: (reason: string, detail: Record<string, string | number>) => void
}

const SYNTHETIC_BROADCAST_ID = 'brd_soak_0001'
const SYNTHETIC_STREAM_ID = 'str_soak_0001'
const SYNTHETIC_LIVE_CHAT_ID = 'chat_soak_0001'

export class FaultyBroadcast {
  readonly #clock: Clock
  readonly #onSafeStop: (reason: string, detail: Record<string, string | number>) => void

  #bound = false
  #live = false
  #statusReadable = true
  #fault: BroadcastFault | null = null
  #remainingCalls = 0
  /** Calls the harness made that the injected fault refused. */
  refusals = 0

  constructor(options: FaultyBroadcastOptions) {
    this.#clock = options.clock
    this.#onSafeStop = options.onSafeStop
  }

  fail(fault: BroadcastFault): void {
    this.#fault = fault
    this.#remainingCalls = fault.calls ?? Number.POSITIVE_INFINITY
  }

  clearFault(): void {
    this.#fault = null
    this.#remainingCalls = 0
  }

  get port(): BroadcastPort {
    return {
      ensureBound: async () => {
        this.#call('liveBroadcasts.insert')
        await Promise.resolve()
        this.#bound = true
        return { broadcastId: SYNTHETIC_BROADCAST_ID, liveChatId: SYNTHETIC_LIVE_CHAT_ID }
      },
      goLive: async () => {
        this.#call('liveBroadcasts.transition')
        await Promise.resolve()
        this.#live = true
        return undefined
      },
      publish: () => Promise.resolve(undefined),
      bound: () => this.#bound,
      // Spec §9.1 keeps 최초 공개 with the operator, and the default config is
      // `private`; the soak never publishes anything.
      publishable: () => false,
    }
  }

  /**
   * One health poll (§9.4(6)). A refused call is not an exception the harness
   * has to handle: T10's monitor records it and the next signal says the status
   * could not be read, which is what the supervisor is supposed to see.
   */
  pollHealth(): void {
    try {
      this.#call('liveStreams.list')
      this.#statusReadable = true
    } catch {
      this.#statusReadable = false
    }
  }

  /** One health poll of `liveStreams.status` + `liveBroadcasts` lifecycle. */
  signals(): readonly HealthSignal[] {
    const stream: LiveStreamStatus | null =
      this.#bound && this.#statusReadable
        ? {
            streamStatus: this.#live ? 'active' : 'ready',
            healthStatus: this.#live ? 'good' : 'noData',
            lastUpdateTimeSeconds: Math.floor(Date.parse(this.#clock.nowUtcIso()) / 1000),
            configurationIssues: [],
          }
        : null
    return deriveBroadcastHealthSignals(
      {
        streamId: this.#bound ? SYNTHETIC_STREAM_ID : null,
        stream,
        broadcastId: this.#bound ? SYNTHETIC_BROADCAST_ID : null,
        lifeCycleStatus: this.#live ? 'live' : this.#bound ? 'ready' : null,
        lifeCycleSource: 'api',
        lastReconciledAt: null,
      },
      { utc: this.#clock.nowUtcIso(), monotonicMs: this.#clock.monotonicMs() },
    )
  }

  /**
   * Makes one API call. A refused call is classified, and only a `safe_stopped`
   * classification reaches the supervisor — everything else is the caller's own
   * retry or degradation, exactly as in T10.
   */
  #call(method: string): void {
    if (this.#fault === null || this.#remainingCalls <= 0) return
    this.#remainingCalls -= 1
    const fault = this.#fault
    if (this.#remainingCalls <= 0) this.#fault = null
    this.refusals += 1

    const classification = classifyYouTubeApiError({
      httpStatus: fault.httpStatus,
      ...(fault.reason === undefined
        ? {}
        : { body: { error: { errors: [{ reason: fault.reason }] } } }),
    })
    if (classification.action === 'safe_stopped') {
      this.#onSafeStop(`broadcast:${classification.kind}`, {
        method,
        kind: classification.kind,
        httpStatus: classification.httpStatus ?? 0,
      })
    }
    throw new Error(`youtube api refused ${method}: ${classification.kind}`)
  }
}
