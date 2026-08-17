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
 * - a failing sweep does not stop the schedule. A retention job that silently
 *   stopped after one bad run is the failure mode this whole task exists to
 *   prevent; the error is reported and the next tick is scheduled anyway.
 */

export interface RetentionSchedulerOptions {
  readonly sweeper: RetentionSweeper
  readonly clock: Clock
  /** Defaults to `sweep.intervalMs` of the sweeper's config. */
  readonly intervalMs?: number
  readonly onResult?: (result: RetentionSweepResult) => void
  readonly onError?: (error: unknown) => void
  readonly logger?: Logger
}

export class RetentionScheduler {
  readonly #sweeper: RetentionSweeper
  readonly #clock: Clock
  readonly #intervalMs: number
  readonly #onResult: ((result: RetentionSweepResult) => void) | undefined
  readonly #onError: ((error: unknown) => void) | undefined
  readonly #logger: Logger

  #timer: TimerHandle | undefined
  #runCount = 0

  constructor(options: RetentionSchedulerOptions) {
    const intervalMs = options.intervalMs ?? options.sweeper.config.sweep.intervalMs
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(
        `retention sweep intervalMs must be a positive integer, got ${String(intervalMs)}`,
      )
    }
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
    return this.#sweeper.run()
  }

  #tick(): void {
    try {
      const result = this.runNow()
      this.#onResult?.(result)
    } catch (error) {
      this.#logger.error('retention sweep failed', { message: (error as Error).message })
      this.#onError?.(error)
    }
    // Scheduled last and unconditionally: see the class comment.
    this.#timer = this.#clock.setTimeout(() => {
      this.#tick()
    }, this.#intervalMs)
  }
}
