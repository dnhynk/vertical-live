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
  /** Whether `lifeCycleStatus` was read from the API this tick or held locally. */
  readonly lifeCycleSource: 'api' | 'local' | 'none'
  /** When `liveBroadcasts.list` last answered; null before the first reconcile. */
  readonly lastReconciledAt: string | null
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
          reason:
            sample.broadcastId === null
              ? 'no_broadcast_yet'
              : sample.lifeCycleSource === 'local'
                ? 'awaiting_reconcile'
                : 'lifecycle_unreadable',
        }
      : sample.lifeCycleStatus === 'live'
        ? { status: 'ok' as const }
        : { status: 'degraded' as const, reason: `lifecycle_${sample.lifeCycleStatus}` }),
    detail: {
      broadcastId: sample.broadcastId,
      lifeCycleStatus: sample.lifeCycleStatus,
      // Where this tick's value came from. `api` is a read of
      // `liveBroadcasts.list`; `local` is the stage this process last drove a
      // transition to and persisted. Both are facts, but only one of them can
      // notice YouTube ending the broadcast on its own, so the reader is told
      // which it has and when the last reconcile was (T44).
      lifeCycleSource: sample.lifeCycleSource,
      lastReconciledAt: sample.lastReconciledAt,
    },
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
    /**
     * The lifecycle stage this process last drove the broadcast to and
     * persisted. Used on the ticks between reconciles so the family stays
     * observable without spending a unit (T44). Omitted leaves those ticks
     * `lifecycle_unreadable`, which is what a caller with no local record
     * should report.
     */
    readonly lifeCycleStage?: string | null
  }
  readonly clock?: Clock
}

/**
 * Polls `liveStreams.list?part=status` on `youtube.broadcast.healthPollIntervalMs`
 * and `liveBroadcasts.list?part=status` on the far slower
 * `lifecycleReconcileIntervalMs`. Both are provisional (BOARD A-15: neither API
 * publishes a polling interval the way `liveChatMessages.list` does), but they
 * are no longer free choices: the first is bounded above by the supervisor's
 * `signalStaleAfterMs` and below by the daily quota, and those two ceilings
 * nearly meet (T44).
 */
export class BroadcastHealthMonitor {
  readonly #api: YouTubeLiveApi
  readonly #config: BroadcastConfig
  readonly #onSignal: HealthSignalSink
  readonly #resources: BroadcastHealthMonitorOptions['resources']
  readonly #clock: Clock

  #running = false
  #timer: TimerHandle | undefined
  /** Monotonic instant of the last `liveBroadcasts.list`; null before the first. */
  #lastReconcileMonotonicMs: number | null = null
  #lastReconciledAtUtc: string | null = null

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
    const { streamId, broadcastId, lifeCycleStage } = this.#resources()

    const sample: BroadcastHealthSample = {
      streamId,
      stream: streamId === null ? null : await this.#readStream(streamId),
      broadcastId,
      ...(await this.#lifeCycle(broadcastId, lifeCycleStage ?? null, observedAt)),
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

  /**
   * `liveBroadcasts.list` costs a unit and the answer changes only when one of
   * our own transitions succeeds, so it is read on
   * `lifecycleReconcileIntervalMs` rather than every tick. In between, the
   * stage the caller persisted is reported instead — a real fact, marked
   * `local` so nobody mistakes it for YouTube agreeing.
   *
   * What this gives up: a broadcast YouTube ends on its own is seen up to one
   * reconcile interval late here. The fast signals cover that case sooner —
   * an ended broadcast takes its stream `inactive` and its chat with it, and
   * both of those are read every tick (T44).
   */
  async #lifeCycle(
    broadcastId: string | null,
    localStage: string | null,
    observedAt: ObservedAt,
  ): Promise<
    Pick<BroadcastHealthSample, 'lifeCycleStatus' | 'lifeCycleSource' | 'lastReconciledAt'>
  > {
    if (broadcastId === null) {
      this.#lastReconcileMonotonicMs = null
      this.#lastReconciledAtUtc = null
      return { lifeCycleStatus: null, lifeCycleSource: 'none', lastReconciledAt: null }
    }
    const due =
      this.#lastReconcileMonotonicMs === null ||
      observedAt.monotonicMs - this.#lastReconcileMonotonicMs >=
        this.#config.lifecycleReconcileIntervalMs
    if (due) {
      const status = await this.#readLifeCycle(broadcastId)
      if (status !== null) {
        this.#lastReconcileMonotonicMs = observedAt.monotonicMs
        this.#lastReconciledAtUtc = observedAt.utc
        return { lifeCycleStatus: status, lifeCycleSource: 'api', lastReconciledAt: observedAt.utc }
      }
      // The read failed. Falling back to the local stage would hide an API that
      // stopped answering, so the tick reports what it is: unreadable.
      return {
        lifeCycleStatus: null,
        lifeCycleSource: 'api',
        lastReconciledAt: this.#lastReconciledAtUtc,
      }
    }
    // Only `live` crosses over. `BroadcastStage` is this product's vocabulary
    // for what it has driven, not YouTube's `lifeCycleStatus`, and the two are
    // kept apart on purpose — reconcile exists to compare them. `live` is the
    // one value the signal actually needs to carry between reconciles; any
    // other stage reports that nobody has asked yet, which is the truth.
    return {
      lifeCycleStatus: localStage === 'live' ? 'live' : null,
      lifeCycleSource: localStage === null ? 'none' : 'local',
      lastReconciledAt: this.#lastReconciledAtUtc,
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
    }, this.#config.healthPollIntervalMs)
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
