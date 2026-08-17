import type { OBSEventTypes } from 'obs-websocket-js/json'

import { systemClock, type Clock, type TimerHandle } from '../clock.js'
import type { HealthSignal, HealthSignalSink } from '../health/types.js'
import type { ObsConfig, ObsThresholdConfig } from './config.js'
import { ObsNotConnectedError } from './client.js'
import type { ObsRequester } from './requester.js'

/**
 * OBS health signal producer (spec §9.4(5)(7)). It only *reports* what
 * `GetStreamStatus` / `GetStats` and `StreamStateChanged` say; T12's supervisor
 * decides what the combination means for the broadcast.
 */

/** `outputActive` / `outputReconnecting` (spec §9.4(5)). */
export const OBS_STREAM_SIGNAL = 'obs.stream'
/** `outputBytes` / `outputDuration` increasing (spec §9.4(5)). */
export const OBS_OUTPUT_PROGRESS_SIGNAL = 'obs.output_progress'
/** Skipped frames in the output and render threads (spec §9.4(7)). */
export const OBS_FRAMES_SIGNAL = 'obs.frames'
/** `outputCongestion` (spec §9.4(7)). */
export const OBS_CONGESTION_SIGNAL = 'obs.congestion'

export const OBS_HEALTH_SIGNAL_NAMES = [
  OBS_STREAM_SIGNAL,
  OBS_OUTPUT_PROGRESS_SIGNAL,
  OBS_FRAMES_SIGNAL,
  OBS_CONGESTION_SIGNAL,
] as const

/**
 * One observation of the stream output.
 *
 * `GetStreamStatus` supplies the output-thread numbers, `GetStats` the
 * render-thread ones. obs-websocket protocol v5 / RPC v1 has **no** dropped-frame
 * field anywhere in its schema — "skipped" is the only frame-loss counter it
 * exposes — so §9.4(7)'s "skipped·dropped frame" is covered by the two skipped
 * counters plus `outputCongestion`, and nothing here invents a dropped count.
 */
export interface ObsOutputSample {
  readonly outputActive: boolean
  readonly outputReconnecting: boolean
  readonly outputDurationMs: number
  readonly outputCongestion: number
  readonly outputBytes: number
  readonly outputSkippedFrames: number
  readonly outputTotalFrames: number
  readonly renderSkippedFrames: number
  readonly renderTotalFrames: number
}

/** Carried between polls; deltas are the whole point of the progress signal. */
export interface ObsProgressState {
  readonly previous: ObsOutputSample | undefined
  /** Consecutive active samples with no byte/duration progress. */
  readonly stalledSamples: number
}

export const INITIAL_PROGRESS_STATE: ObsProgressState = Object.freeze({
  previous: undefined,
  stalledSamples: 0,
})

export interface ObservedAt {
  readonly utc: string
  readonly monotonicMs: number
}

export interface DerivedObsHealth {
  readonly signals: readonly HealthSignal[]
  readonly state: ObsProgressState
}

/**
 * Pure derivation so the thresholds and delta arithmetic are testable without a
 * socket. Every threshold is `provisional` (BOARD A-15) — see `config/default.json`.
 */
export function deriveObsHealthSignals(
  sample: ObsOutputSample,
  state: ObsProgressState,
  thresholds: ObsThresholdConfig,
  observedAt: ObservedAt,
): DerivedObsHealth {
  const previous = state.previous

  const streamSignal = signal(OBS_STREAM_SIGNAL, observedAt, {
    ...(sample.outputActive
      ? sample.outputReconnecting
        ? { status: 'degraded' as const, reason: 'output_reconnecting' }
        : { status: 'ok' as const }
      : { status: 'degraded' as const, reason: 'output_inactive' }),
    detail: {
      outputActive: sample.outputActive,
      outputReconnecting: sample.outputReconnecting,
      outputDurationMs: sample.outputDurationMs,
      outputBytes: sample.outputBytes,
    },
  })

  let stalledSamples = 0
  let progressSignal: HealthSignal
  if (!sample.outputActive) {
    progressSignal = signal(OBS_OUTPUT_PROGRESS_SIGNAL, observedAt, {
      status: 'unknown',
      reason: 'output_inactive',
      detail: { outputActive: false, bytesDelta: null, durationDeltaMs: null, stalledSamples: 0 },
    })
  } else if (previous === undefined || !previous.outputActive) {
    progressSignal = signal(OBS_OUTPUT_PROGRESS_SIGNAL, observedAt, {
      status: 'unknown',
      reason: 'no_previous_sample',
      detail: { outputActive: true, bytesDelta: null, durationDeltaMs: null, stalledSamples: 0 },
    })
  } else {
    const bytesDelta = sample.outputBytes - previous.outputBytes
    const durationDeltaMs = sample.outputDurationMs - previous.outputDurationMs
    const progressed = bytesDelta > 0 && durationDeltaMs > 0
    stalledSamples = progressed ? 0 : state.stalledSamples + 1
    const stalled = stalledSamples >= thresholds.stalledSamplesDegradedAt
    progressSignal = signal(OBS_OUTPUT_PROGRESS_SIGNAL, observedAt, {
      ...(stalled
        ? { status: 'degraded' as const, reason: 'output_not_progressing' }
        : { status: 'ok' as const }),
      detail: { outputActive: true, bytesDelta, durationDeltaMs, stalledSamples },
    })
  }

  let framesSignal: HealthSignal
  if (previous === undefined) {
    framesSignal = signal(OBS_FRAMES_SIGNAL, observedAt, {
      status: 'unknown',
      reason: 'no_previous_sample',
      detail: {
        outputSkippedDelta: null,
        outputTotalDelta: null,
        outputSkippedRatio: null,
        renderSkippedDelta: null,
        renderTotalDelta: null,
        renderSkippedRatio: null,
      },
    })
  } else {
    // A restarted output resets the counters, so a negative delta means "new
    // counter", not "negative frames".
    const outputSkippedDelta = nonNegativeDelta(sample.outputSkippedFrames, previous.outputSkippedFrames)
    const outputTotalDelta = nonNegativeDelta(sample.outputTotalFrames, previous.outputTotalFrames)
    const renderSkippedDelta = nonNegativeDelta(sample.renderSkippedFrames, previous.renderSkippedFrames)
    const renderTotalDelta = nonNegativeDelta(sample.renderTotalFrames, previous.renderTotalFrames)
    const outputSkippedRatio = ratio(outputSkippedDelta, outputTotalDelta)
    const renderSkippedRatio = ratio(renderSkippedDelta, renderTotalDelta)
    const detail = {
      outputSkippedDelta,
      outputTotalDelta,
      outputSkippedRatio,
      renderSkippedDelta,
      renderTotalDelta,
      renderSkippedRatio,
    }

    if (outputTotalDelta === 0 && renderTotalDelta === 0) {
      framesSignal = signal(OBS_FRAMES_SIGNAL, observedAt, {
        status: 'unknown',
        reason: 'no_frames_in_window',
        detail,
      })
    } else {
      const worst = Math.max(outputSkippedRatio ?? 0, renderSkippedRatio ?? 0)
      framesSignal = signal(OBS_FRAMES_SIGNAL, observedAt, {
        ...(worst >= thresholds.skippedFrameRatioDegradedAt
          ? { status: 'degraded' as const, reason: 'skipped_frames' }
          : { status: 'ok' as const }),
        detail,
      })
    }
  }

  const congestionSignal = signal(OBS_CONGESTION_SIGNAL, observedAt, {
    ...(sample.outputActive
      ? sample.outputCongestion >= thresholds.congestionDegradedAt
        ? { status: 'degraded' as const, reason: 'congestion' }
        : { status: 'ok' as const }
      : { status: 'unknown' as const, reason: 'output_inactive' }),
    detail: { outputCongestion: sample.outputCongestion },
  })

  return {
    signals: [streamSignal, progressSignal, framesSignal, congestionSignal],
    state: { previous: sample, stalledSamples },
  }
}

/** Every signal this producer owns, marked unobservable with one reason. */
export function unobservableObsHealthSignals(
  reason: string,
  observedAt: ObservedAt,
): readonly HealthSignal[] {
  return OBS_HEALTH_SIGNAL_NAMES.map((name) =>
    signal(name, observedAt, { status: 'unknown', reason, detail: {} }),
  )
}

export interface ObsHealthMonitorOptions {
  readonly source: ObsRequester
  readonly config: ObsConfig
  readonly onSignal: HealthSignalSink
  readonly clock?: Clock
}

/**
 * Polls `GetStreamStatus`/`GetStats` on `obs.pollIntervalMs` and mirrors
 * `StreamStateChanged` so an output that stops between polls is reported at once.
 */
export class ObsHealthMonitor {
  readonly #source: ObsRequester
  readonly #config: ObsConfig
  readonly #onSignal: HealthSignalSink
  readonly #clock: Clock

  #state: ObsProgressState = INITIAL_PROGRESS_STATE
  #running = false
  #timer: TimerHandle | undefined

  constructor(options: ObsHealthMonitorOptions) {
    this.#source = options.source
    this.#config = options.config
    this.#onSignal = options.onSignal
    this.#clock = options.clock ?? systemClock
  }

  get running(): boolean {
    return this.#running
  }

  /**
   * Subscribes to `StreamStateChanged` and schedules the first poll one interval
   * out. Call `poll()` directly for an immediate sample (the probe does).
   */
  start(): void {
    if (this.#running) {
      return
    }
    this.#running = true
    this.#source.on('StreamStateChanged', this.#handleStreamStateChanged)
    this.#scheduleNext()
  }

  stop(): void {
    if (!this.#running) {
      return
    }
    this.#running = false
    this.#source.off('StreamStateChanged', this.#handleStreamStateChanged)
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
    let signals: readonly HealthSignal[]
    try {
      const [status, stats] = await Promise.all([
        this.#source.call('GetStreamStatus'),
        this.#source.call('GetStats'),
      ])
      const sample: ObsOutputSample = {
        outputActive: status.outputActive,
        outputReconnecting: status.outputReconnecting,
        outputDurationMs: status.outputDuration,
        outputCongestion: status.outputCongestion,
        outputBytes: status.outputBytes,
        outputSkippedFrames: status.outputSkippedFrames,
        outputTotalFrames: status.outputTotalFrames,
        renderSkippedFrames: stats.renderSkippedFrames,
        renderTotalFrames: stats.renderTotalFrames,
      }
      const derived = deriveObsHealthSignals(sample, this.#state, this.#config.thresholds, observedAt)
      this.#state = derived.state
      signals = derived.signals
    } catch (error) {
      // Deltas across a connection gap are meaningless; start over on recovery.
      this.#state = INITIAL_PROGRESS_STATE
      signals = unobservableObsHealthSignals(observationFailureReason(error), observedAt)
    }
    for (const item of signals) {
      this.#onSignal(item)
    }
    return signals
  }

  readonly #handleStreamStateChanged = (data: OBSEventTypes['StreamStateChanged']): void => {
    this.#onSignal(
      signal(
        OBS_STREAM_SIGNAL,
        { utc: this.#clock.nowUtcIso(), monotonicMs: this.#clock.monotonicMs() },
        {
          ...(data.outputActive
            ? { status: 'ok' as const }
            : { status: 'degraded' as const, reason: 'output_inactive' }),
          detail: {
            outputActive: data.outputActive,
            outputState: data.outputState,
            source: 'StreamStateChanged',
          },
        },
      ),
    )
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
    }, this.#config.pollIntervalMs)
  }
}

interface SignalBody {
  readonly status: HealthSignal['status']
  readonly reason?: string
  readonly detail: HealthSignal['detail']
}

function signal(name: string, observedAt: ObservedAt, body: SignalBody): HealthSignal {
  return {
    component: 'obs',
    name,
    status: body.status,
    observedAtUtc: observedAt.utc,
    observedAtMonotonicMs: observedAt.monotonicMs,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
    detail: body.detail,
  }
}

function nonNegativeDelta(current: number, previous: number): number {
  return Math.max(0, current - previous)
}

function ratio(part: number, total: number): number | null {
  return total > 0 ? part / total : null
}

/** Short, stable reason text; never carries a payload or a secret. */
function observationFailureReason(error: unknown): string {
  if (error instanceof ObsNotConnectedError) {
    return 'obs_not_connected'
  }
  if (error instanceof Error) {
    return `request_failed:${error.name}`
  }
  return 'request_failed'
}
