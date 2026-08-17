import { systemClock, type Clock, type TimerHandle } from '../../clock.js'
import type { HealthSignal, HealthSignalSink } from '../../health/types.js'
import { YouTubeApiCallError, type LiveStreamStatus, type YouTubeLiveApi } from './api.js'
import type { BroadcastConfig } from './config.js'

/**
 * Health signals §9.4(6) asks for: "YouTube `liveStreams.status`의 stream·health
 * 상태와 configuration issues, `liveBroadcasts` lifecycle".
 *
 * Like the OBS producer (T2), this only reports. It never concludes that the system
 * is degraded — T12's supervisor aggregates the eight signal families and decides.
 *
 * Value ranges are the documented ones (both checked 2026-08-17,
 * https://developers.google.com/youtube/v3/live/docs/liveStreams and
 * .../liveBroadcasts): `streamStatus ∈ {active, created, error, inactive, ready}`,
 * `healthStatus.status ∈ {good, ok, bad, noData}`, `configurationIssues[].severity
 * ∈ {info, warning, error}`, `lifeCycleStatus ∈ {complete, created, live,
 * liveStarting, ready, revoked, testStarting, testing}`.
 */

export const YOUTUBE_STREAM_STATUS_SIGNAL = 'youtube.stream_status'
export const YOUTUBE_STREAM_HEALTH_SIGNAL = 'youtube.stream_health'
export const YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL = 'youtube.broadcast_lifecycle'

export const YOUTUBE_BROADCAST_HEALTH_SIGNAL_NAMES = [
  YOUTUBE_STREAM_STATUS_SIGNAL,
  YOUTUBE_STREAM_HEALTH_SIGNAL,
  YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL,
] as const

export interface ObservedAt {
  readonly utc: string
  readonly monotonicMs: number
}

/** What one poll saw. `null` for a resource this poll could not read. */
export interface BroadcastHealthSample {
  readonly streamId: string | null
  readonly stream: LiveStreamStatus | null
  readonly broadcastId: string | null
  readonly lifeCycleStatus: string | null
}

/** `noData` is not a fault: a stream nobody is pushing to has nothing to report. */
const HEALTH_STATUS_DEGRADED = new Set(['bad'])
const HEALTH_STATUS_OK = new Set(['good', 'ok'])

export function deriveBroadcastHealthSignals(
  sample: BroadcastHealthSample,
  observedAt: ObservedAt,
): readonly HealthSignal[] {
  const streamStatus = sample.stream?.streamStatus ?? null
  const issues = sample.stream?.configurationIssues ?? []
  const worstSeverity = issues.some((issue) => issue.severity === 'error')
    ? 'error'
    : issues.some((issue) => issue.severity === 'warning')
      ? 'warning'
      : issues.length > 0
        ? 'info'
        : null

  const statusSignal =
    sample.stream === null
      ? signal(YOUTUBE_STREAM_STATUS_SIGNAL, observedAt, {
          status: 'unknown',
          reason: sample.streamId === null ? 'no_stream_yet' : 'status_unreadable',
          detail: { streamId: sample.streamId, streamStatus: null },
        })
      : signal(YOUTUBE_STREAM_STATUS_SIGNAL, observedAt, {
          ...(streamStatus === 'active'
            ? { status: 'ok' as const }
            : streamStatus === null
              ? { status: 'unknown' as const, reason: 'status_absent' }
              : { status: 'degraded' as const, reason: `stream_${streamStatus}` }),
          detail: { streamId: sample.streamId, streamStatus },
        })

  const healthValue = sample.stream?.healthStatus ?? null
  const healthSignal =
    sample.stream === null
      ? signal(YOUTUBE_STREAM_HEALTH_SIGNAL, observedAt, {
          status: 'unknown',
          reason: sample.streamId === null ? 'no_stream_yet' : 'status_unreadable',
          detail: { healthStatus: null, configurationIssueCount: 0, worstSeverity: null },
        })
      : signal(YOUTUBE_STREAM_HEALTH_SIGNAL, observedAt, {
          ...(healthValue !== null && HEALTH_STATUS_DEGRADED.has(healthValue)
            ? { status: 'degraded' as const, reason: 'health_bad' }
            : worstSeverity === 'error'
              ? { status: 'degraded' as const, reason: 'configuration_issue_error' }
              : healthValue !== null && HEALTH_STATUS_OK.has(healthValue)
                ? { status: 'ok' as const }
                : {
                    status: 'unknown' as const,
                    reason: healthValue === 'noData' ? 'health_no_data' : 'health_absent',
                  }),
          detail: {
            healthStatus: healthValue,
            lastUpdateTimeSeconds: sample.stream.lastUpdateTimeSeconds,
            configurationIssueCount: issues.length,
            worstSeverity,
            // Types only: the descriptions are free text from YouTube and are not
            // needed to decide anything.
            issueTypes: issues.map((issue) => issue.type).join(','),
          },
        })

  const lifeCycleSignal = signal(YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL, observedAt, {
    ...(sample.lifeCycleStatus === null
      ? {
          status: 'unknown' as const,
          reason: sample.broadcastId === null ? 'no_broadcast_yet' : 'lifecycle_unreadable',
        }
      : sample.lifeCycleStatus === 'live'
        ? { status: 'ok' as const }
        : { status: 'degraded' as const, reason: `lifecycle_${sample.lifeCycleStatus}` }),
    detail: { broadcastId: sample.broadcastId, lifeCycleStatus: sample.lifeCycleStatus },
  })

  return [statusSignal, healthSignal, lifeCycleSignal]
}

export interface BroadcastHealthMonitorOptions {
  readonly api: YouTubeLiveApi
  readonly config: BroadcastConfig
  readonly onSignal: HealthSignalSink
  /** Ids to watch; re-read every poll so a rollover is picked up. */
  readonly resources: () => {
    readonly streamId: string | null
    readonly broadcastId: string | null
  }
  readonly clock?: Clock
}

/**
 * Polls `liveStreams.list?part=status` and `liveBroadcasts.list?part=status` on
 * `youtube.broadcast.statusPollIntervalMs` (provisional, BOARD A-15: neither API
 * publishes a polling interval the way `liveChatMessages.list` does).
 */
export class BroadcastHealthMonitor {
  readonly #api: YouTubeLiveApi
  readonly #config: BroadcastConfig
  readonly #onSignal: HealthSignalSink
  readonly #resources: BroadcastHealthMonitorOptions['resources']
  readonly #clock: Clock

  #running = false
  #timer: TimerHandle | undefined

  constructor(options: BroadcastHealthMonitorOptions) {
    this.#api = options.api
    this.#config = options.config
    this.#onSignal = options.onSignal
    this.#resources = options.resources
    this.#clock = options.clock ?? systemClock
  }

  get running(): boolean {
    return this.#running
  }

  start(): void {
    if (this.#running) {
      return
    }
    this.#running = true
    this.#scheduleNext()
  }

  stop(): void {
    if (!this.#running) {
      return
    }
    this.#running = false
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  /** One sample. Never rejects: a failed observation is itself a signal. */
  async poll(): Promise<readonly HealthSignal[]> {
    const observedAt: ObservedAt = {
      utc: this.#clock.nowUtcIso(),
      monotonicMs: this.#clock.monotonicMs(),
    }
    const { streamId, broadcastId } = this.#resources()

    const sample: BroadcastHealthSample = {
      streamId,
      stream: streamId === null ? null : await this.#readStream(streamId),
      broadcastId,
      lifeCycleStatus: broadcastId === null ? null : await this.#readLifeCycle(broadcastId),
    }

    const signals = deriveBroadcastHealthSignals(sample, observedAt)
    for (const item of signals) {
      this.#onSignal(item)
    }
    return signals
  }

  /**
   * Status only: `listLiveStreamStatuses` asks for `part=id,status`, so the response
   * carries no `cdn.ingestionInfo.streamName` at all. Review round 1 (M1) found the
   * previous full `listLiveStreams()` call staging the stream key in
   * `StreamKeyCustodian` on **every poll** without ever committing or discarding it —
   * a key retained outside the vault, against BOARD A-16. A poll cannot leak what it
   * never requested.
   */
  async #readStream(streamId: string): Promise<LiveStreamStatus | null> {
    try {
      const page = await this.#api.listLiveStreamStatuses({ ids: [streamId] }, { maxPages: 1 })
      return page.items[0]?.status ?? null
    } catch (error) {
      // Quota, network and 5xx all mean "not observed"; they do not mean "bad".
      this.#swallow(error)
      return null
    }
  }

  async #readLifeCycle(broadcastId: string): Promise<string | null> {
    try {
      const page = await this.#api.listBroadcasts({ ids: [broadcastId] }, { maxPages: 1 })
      return page.items[0]?.lifeCycleStatus ?? null
    } catch (error) {
      this.#swallow(error)
      return null
    }
  }

  #swallow(error: unknown): void {
    if (error instanceof YouTubeApiCallError) {
      return
    }
    // A shape error is a bug in this module's parsing, not an observation: it must
    // not be turned into a health signal that hides it.
    throw error
  }

  #scheduleNext(): void {
    if (!this.#running) {
      return
    }
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      void this.poll().then(() => {
        this.#scheduleNext()
      })
    }, this.#config.statusPollIntervalMs)
  }
}

interface SignalBody {
  readonly status: HealthSignal['status']
  readonly reason?: string
  readonly detail: HealthSignal['detail']
}

function signal(name: string, observedAt: ObservedAt, body: SignalBody): HealthSignal {
  return {
    component: 'youtube',
    name,
    status: body.status,
    observedAtUtc: observedAt.utc,
    observedAtMonotonicMs: observedAt.monotonicMs,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
    detail: body.detail,
  }
}
