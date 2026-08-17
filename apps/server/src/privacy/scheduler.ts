import type { Clock, TimerHandle } from '../clock.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { RetentionSweepResult, RetentionSweeper } from './retention.js'

/**
 * Periodic driver for the retention sweep (spec §12.4 "자동 삭제"). Time comes
 * from the injected `Clock`, so the 30-day rules are testable with a virtual
 * clock instead of a 30-day wait (TASK_SPECS §T13 acceptance 1, 공통 규약 시간).
 *
 * Two behaviours are deliberate:
 *
 * - `start()` sweeps immediately, then on the interval. After downtime the
 *   deletions that came due while the host was off must not wait a full period.
 * - a failing sweep does not stop the schedule, and neither does a failing
 *   *report* of one. A retention job that silently stopped after one bad run is
 *   the failure mode this whole task exists to prevent, so the next tick is
 *   registered in a `finally` and a sink that throws is contained and recorded
 *   rather than allowed to escape (review round 2, M1).
 */

export interface RetentionSchedulerOptions {
  readonly sweeper: RetentionSweeper
  readonly clock: Clock
  /** Defaults to `sweep.intervalMs` of the sweeper's config. */
  readonly intervalMs?: number
  /** Required: where each sweep result goes (T12 alerts on `clean === false`). */
  readonly onResult: (result: RetentionSweepResult) => void
  /** Required: where a failed sweep goes. There is no silent default. */
  readonly onError: (error: unknown) => void
  readonly logger?: Logger
}

/** One recorded failure of a scheduled sweep, or of reporting one. */
export interface RetentionSweepFailure {
  readonly at: string
  /** `sweep` is the run itself; the others are a caller sink that threw. */
  readonly stage: 'sweep' | 'onResult' | 'onError'
  readonly error: unknown
}

export class RetentionScheduler {
  readonly #sweeper: RetentionSweeper
  readonly #clock: Clock
  readonly #intervalMs: number
  readonly #onResult: (result: RetentionSweepResult) => void
  readonly #onError: (error: unknown) => void
  readonly #logger: Logger
  readonly #failures: RetentionSweepFailure[] = []

  #timer: TimerHandle | undefined
  #runCount = 0
  #lastResult: RetentionSweepResult | undefined

  constructor(options: RetentionSchedulerOptions) {
    const intervalMs = options.intervalMs ?? options.sweeper.config.sweep.intervalMs
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(
        `retention sweep intervalMs must be a positive integer, got ${String(intervalMs)}`,
      )
    }
    // Both sinks are required and validated here (review round 1, B2): the earlier
    // optional versions let a missed T12 wire turn a failed retention sweep — or an
    // unmet §12.4 obligation in a result — into silence.
    requireSink(options.onResult, 'onResult')
    requireSink(options.onError, 'onError')
    this.#sweeper = options.sweeper
    this.#clock = options.clock
    this.#intervalMs = intervalMs
    this.#onResult = options.onResult
    this.#onError = options.onError
    this.#logger = options.logger ?? silentLogger
  }

  get running(): boolean {
    return this.#timer !== undefined
  }

  get runCount(): number {
    return this.#runCount
  }

  /** Every failed sweep, oldest first. Readable by T12's health aggregation. */
  get failures(): readonly RetentionSweepFailure[] {
    return this.#failures
  }

  /** The most recent completed sweep, or `undefined` before the first one. */
  get lastResult(): RetentionSweepResult | undefined {
    return this.#lastResult
  }

  /** True when the last run failed or left an unmet §12.4 obligation. */
  get unhealthy(): boolean {
    return this.#failures.length > 0 || this.#lastResult?.clean === false
  }

  get intervalMs(): number {
    return this.#intervalMs
  }

  /** Sweeps now and every `intervalMs` after that. Idempotent. */
  start(): void {
    if (this.#timer !== undefined) return
    this.#tick()
  }

  stop(): void {
    if (this.#timer === undefined) return
    this.#clock.clearTimeout(this.#timer)
    this.#timer = undefined
  }

  /** One sweep, outside the schedule. Errors propagate to the caller. */
  runNow(): RetentionSweepResult {
    this.#runCount += 1
    const result = this.#sweeper.run()
    this.#lastResult = result
    return result
  }

  #tick(): void {
    try {
      const result = this.runNow()
      if (!result.clean) {
        this.#logger.warn('retention sweep left an unmet obligation', {
          reverificationDue: result.reverificationDue.length,
          truncated: result.truncated.length,
          failed: result.failed.length,
        })
      }
      this.#notify(() => this.#onResult(result), 'onResult')
    } catch (error) {
      // Recorded in state as well as reported, so an `onResult`/`onError` that
      // itself throws cannot erase the fact that a sweep failed.
      this.#failures.push({ at: this.#clock.nowUtcIso(), stage: 'sweep', error })
      this.#logger.error('retention sweep failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      this.#notify(() => this.#onError(error), 'onError')
    } finally {
      // `finally`, not a trailing statement (review round 2, M1): a throwing sink
      // used to skip this line, so a broken alert path silently ended the
      // schedule and every later §12.4 deletion with it. The next tick is now
      // registered on every path out of the try.
      this.#timer = this.#clock.setTimeout(() => {
        this.#tick()
      }, this.#intervalMs)
    }
  }

  /**
   * Delivers to a caller-supplied sink without letting it break the driver. A
   * sink that throws is itself recorded and logged — the failure stays
   * observable — but it never escapes into the host timer callback, where an
   * uncaught exception would take a 24/7 process down.
   */
  #notify(deliver: () => void, stage: 'onResult' | 'onError'): void {
    try {
      deliver()
    } catch (sinkError) {
      this.#failures.push({ at: this.#clock.nowUtcIso(), stage, error: sinkError })
      this.#logger.error('retention scheduler sink threw', {
        stage,
        message: sinkError instanceof Error ? sinkError.message : String(sinkError),
      })
    }
  }
}

/** Refuses a missing or non-callable sink, including from a plain-JS caller. */
function requireSink(value: unknown, name: string): void {
  if (typeof value !== 'function') {
    throw new TypeError(
      `${name} is required: a §12.4 retention result must not be able to disappear because a callback was not wired`,
    )
  }
}
