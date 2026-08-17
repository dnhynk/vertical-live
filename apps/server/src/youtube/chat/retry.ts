import type { Clock, TimerHandle } from '../../clock.js'
import { createExponentialBackoff, type BackoffPolicy } from '../quota/backoff.js'
import type { ChatReconnectConfig } from './config.js'

/**
 * Reconnect pacing shared by both chat source paths. The policy itself is T3's
 * (`createExponentialBackoff`/`decideRetry`); this file only builds it from the
 * chat config and provides a sleep that a `stop()` can cut short — a supervisor
 * asking the source to stand down must not wait out a 60-second backoff.
 */

export function createChatBackoff(
  config: ChatReconnectConfig,
  random?: () => number,
): BackoffPolicy {
  return createExponentialBackoff({
    initialDelayMs: config.initialDelayMs,
    maxDelayMs: config.maxDelayMs,
    factor: config.factor,
    jitterRatio: config.jitterRatio,
    maxAttempts: config.maxAttempts,
    ...(random === undefined ? {} : { random }),
  })
}

/** A sleep that can be cancelled, using the injected clock (spec §10.2). */
export class CancellableDelay {
  readonly #clock: Clock
  #handle: TimerHandle | undefined
  #resolve: (() => void) | undefined

  constructor(clock: Clock) {
    this.#clock = clock
  }

  async wait(delayMs: number): Promise<void> {
    if (delayMs <= 0) return
    await new Promise<void>((resolve) => {
      this.#resolve = resolve
      this.#handle = this.#clock.setTimeout(() => {
        this.#handle = undefined
        this.#resolve = undefined
        resolve()
      }, delayMs)
    })
  }

  /** Resolves a pending `wait()` immediately. Safe to call when idle. */
  cancel(): void {
    const handle = this.#handle
    const resolve = this.#resolve
    this.#handle = undefined
    this.#resolve = undefined
    if (handle !== undefined) this.#clock.clearTimeout(handle)
    resolve?.()
  }
}

/** What a source run ended with, so the orchestrator can decide what is next. */
export interface ChatRunResult {
  /**
   * - `stopped`: the source will not recover on its own (auth, chat ended,…).
   * - `fallback`: this path keeps failing; try the other one.
   * - `cancelled`: `stop()` was called.
   * - `switch_back`: the REST poller's turn at the primary path is over.
   */
  readonly outcome: 'stopped' | 'fallback' | 'cancelled' | 'switch_back'
  readonly reason: string
}

/** Access-token side of T3's `TokenManager`, narrowed to what a source needs. */
export interface ChatAccessTokens {
  getAccessToken(): Promise<string>
  forceRefresh(): Promise<unknown>
}
