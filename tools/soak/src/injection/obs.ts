import type { Clock, HealthSignal } from '@vl/server'
import type { ObsPort } from '@vl/server/supervisor'
import {
  deriveObsHealthSignals,
  INITIAL_PROGRESS_STATE,
  loadObsConfig,
  unobservableObsHealthSignals,
  type ObsOutputSample,
  type ObsProgressState,
  type ObsThresholdConfig,
} from '@vl/server/obs'

/**
 * OBS under fault injection (spec §11 rows "RTMPS 단절", "OBS crash").
 *
 * It is not a mock of the *health verdict*: the samples it produces go through
 * the production `deriveObsHealthSignals`, so the signal names, the reason tokens
 * (`output_reconnecting`, `output_not_progressing`) and the threshold arithmetic
 * that reach the supervisor's aggregator are exactly the ones a real encoder
 * produces. Only the numbers in the sample are ours.
 *
 * The two recoveries it models are the ones §9.2/§10.2 actually perform:
 *
 * - `obs-stream` restart re-establishes a wedged output. A cut RTMPS connection
 *   that a restart of the output fixes is the ordinary transient (§9.1);
 * - `obs-process` relaunch brings back an OBS that died. It is T17's Windows
 *   script in production, so it is injectable here: `relauncher: false` is what
 *   `main.ts` does today (the action rejects), and that row ends in
 *   `safe_stopped` on purpose.
 */

export type ObsFault =
  /** Healthy: output active, bytes and frames advancing. */
  | 'none'
  /** RTMPS cut: the output reports reconnecting and stops progressing. */
  | 'rtmps_cut'
  /** The OBS process is gone: nothing about it can be observed at all. */
  | 'process_crash'

export interface FaultyObsOptions {
  readonly clock: Clock
  /** Whether an `obs-process` relaunch action exists (T17). */
  readonly relauncher?: boolean
  readonly thresholds?: ObsThresholdConfig
}

/** Bytes and frames one healthy poll adds. Synthetic, obviously not measured. */
const BYTES_PER_SAMPLE = 750_000
const FRAMES_PER_SAMPLE = 300

export class FaultyObs {
  readonly #clock: Clock
  readonly #thresholds: ObsThresholdConfig
  readonly #relauncher: boolean

  #fault: ObsFault = 'none'
  #streamActive = false
  #connected = false
  #progress: ObsProgressState = INITIAL_PROGRESS_STATE
  #bytes = 0
  #durationMs = 0
  #outputFrames = 0
  #renderFrames = 0
  #reconnectAttempts = 0

  /** Counted so a test can prove which recovery acted (spec §10.2 one each). */
  readonly restarts = { stream: 0, process: 0, browserSource: 0 }

  constructor(options: FaultyObsOptions) {
    this.#clock = options.clock
    this.#thresholds = options.thresholds ?? loadObsConfig().thresholds
    this.#relauncher = options.relauncher ?? false
  }

  get fault(): ObsFault {
    return this.#fault
  }

  get connected(): boolean {
    return this.#connected && this.#fault !== 'process_crash'
  }

  get streaming(): boolean {
    return this.#streamActive && this.#fault !== 'process_crash'
  }

  /** `ObsClient`'s own reconnect counter, which T12 observes but never drives. */
  get reconnectAttempts(): number {
    return this.#reconnectAttempts
  }

  // ------------------------------------------------------------ fault control

  cutRtmps(): void {
    this.#fault = 'rtmps_cut'
  }

  crashProcess(): void {
    this.#fault = 'process_crash'
    this.#connected = false
    this.#streamActive = false
  }

  clearFault(): void {
    this.#fault = 'none'
    this.#reconnectAttempts = 0
  }

  // -------------------------------------------------------------------- ports

  get port(): ObsPort {
    return {
      connected: () => this.connected,
      setStreamServiceFromVault: () => {
        if (this.#fault === 'process_crash') {
          return Promise.reject(new Error('obs is not reachable'))
        }
        this.#connected = true
        return Promise.resolve()
      },
      startStream: () => {
        if (this.#fault === 'process_crash') {
          return Promise.reject(new Error('obs is not reachable'))
        }
        this.#connected = true
        this.#streamActive = true
        return Promise.resolve()
      },
    }
  }

  /** `ComponentActions.obsStream`: restarting a wedged output re-establishes it. */
  readonly restartStream = (signal: AbortSignal): Promise<void> => {
    this.restarts.stream += 1
    if (signal.aborted) return Promise.resolve()
    if (this.#fault === 'process_crash') {
      return Promise.reject(new Error('obs process is not running'))
    }
    if (this.#fault === 'rtmps_cut') this.#fault = 'none'
    this.#streamActive = true
    return Promise.resolve()
  }

  /** `ComponentActions.obsProcess`: T17's relaunch, or its documented absence. */
  readonly relaunchProcess = (signal: AbortSignal): Promise<void> => {
    this.restarts.process += 1
    if (!this.#relauncher) {
      return Promise.reject(new Error('obs process launch is not configured (T17)'))
    }
    if (signal.aborted) return Promise.resolve()
    this.#fault = 'none'
    this.#connected = true
    this.#streamActive = true
    this.#reconnectAttempts = 0
    return Promise.resolve()
  }

  /** `ComponentActions.rendererSource`: refreshing the OBS Browser Source. */
  readonly refreshBrowserSource = (signal: AbortSignal): Promise<void> => {
    this.restarts.browserSource += 1
    if (signal.aborted) return Promise.resolve()
    if (this.#fault === 'process_crash') {
      return Promise.reject(new Error('obs process is not running'))
    }
    return Promise.resolve()
  }

  // ------------------------------------------------------------------ signals

  /** One poll's worth of §9.4(5)(7) signals, built the production way. */
  signals(): readonly HealthSignal[] {
    const observedAt = { utc: this.#clock.nowUtcIso(), monotonicMs: this.#clock.monotonicMs() }
    if (this.#fault === 'process_crash') {
      this.#reconnectAttempts += 1
      this.#progress = INITIAL_PROGRESS_STATE
      return unobservableObsHealthSignals('obs_not_connected', observedAt)
    }
    const derived = deriveObsHealthSignals(this.sample(), this.#progress, this.#thresholds, {
      utc: observedAt.utc,
      monotonicMs: observedAt.monotonicMs,
    })
    this.#progress = derived.state
    return derived.signals
  }

  /** The numbers `GetStreamStatus` + `GetStats` would return for this state. */
  sample(): ObsOutputSample {
    const progressing = this.#streamActive && this.#fault === 'none'
    if (progressing) {
      this.#bytes += BYTES_PER_SAMPLE
      this.#durationMs += 1_000
      this.#outputFrames += FRAMES_PER_SAMPLE
      this.#renderFrames += FRAMES_PER_SAMPLE
    }
    return {
      outputActive: this.#streamActive,
      outputReconnecting: this.#fault === 'rtmps_cut',
      outputDurationMs: this.#durationMs,
      outputCongestion: 0,
      outputBytes: this.#bytes,
      outputSkippedFrames: 0,
      outputTotalFrames: this.#outputFrames,
      renderSkippedFrames: 0,
      renderTotalFrames: this.#renderFrames,
    }
  }
}
