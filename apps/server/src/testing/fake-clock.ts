import type { Clock, TimerHandle } from '../clock.js'

/**
 * Deterministic `Clock` for tests: backoff, poll intervals and verification
 * deadlines are driven by `advance()` instead of real time (spec §10.2 requires
 * every time-dependent module to take an injected clock).
 */
export interface FakeClockOptions {
  /** Wall-clock base for `nowUtcIso()`. Fixed by default so output is stable. */
  readonly epochMs?: number
  /** Monotonic starting reading. */
  readonly monotonicStartMs?: number
  /**
   * When true, `setTimeout` advances the clock by the delay and queues the
   * handler immediately. Use it for code that sleeps in a loop until a deadline
   * (`ObsControl`), never for code whose timeout must *not* fire.
   */
  readonly autoAdvance?: boolean
}

interface ScheduledTimer {
  readonly id: number
  readonly dueAtMs: number
  readonly sequence: number
  readonly handler: () => void
}

/** 2026-01-01T00:00:00.000Z — an obvious synthetic instant, not "now". */
const DEFAULT_EPOCH_MS = Date.UTC(2026, 0, 1)

export class FakeClock implements Clock {
  readonly #epochMs: number
  readonly #autoAdvance: boolean
  #monotonicMs: number
  #timers = new Map<number, ScheduledTimer>()
  #nextId = 1
  #sequence = 0

  constructor(options: FakeClockOptions = {}) {
    this.#epochMs = options.epochMs ?? DEFAULT_EPOCH_MS
    this.#monotonicMs = options.monotonicStartMs ?? 0
    this.#autoAdvance = options.autoAdvance === true
  }

  nowUtcIso(): string {
    return new Date(this.#epochMs + this.#monotonicMs).toISOString()
  }

  monotonicMs(): number {
    return this.#monotonicMs
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    const id = this.#nextId++
    if (this.#autoAdvance) {
      this.#monotonicMs += delayMs
      queueMicrotask(handler)
      return toHandle(id)
    }
    this.#timers.set(id, {
      id,
      dueAtMs: this.#monotonicMs + delayMs,
      sequence: this.#sequence++,
      handler,
    })
    return toHandle(id)
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(fromHandle(handle))
  }

  get pendingTimerCount(): number {
    return this.#timers.size
  }

  /**
   * Moves time forward, firing every timer that comes due in order, and lets
   * pending promise callbacks run in between so that async work scheduled by a
   * timer is observable when `advance()` resolves.
   */
  async advance(deltaMs: number): Promise<void> {
    const targetMs = this.#monotonicMs + deltaMs
    for (;;) {
      const next = this.#nextDueTimer(targetMs)
      if (next === undefined) {
        break
      }
      this.#monotonicMs = next.dueAtMs
      this.#timers.delete(next.id)
      next.handler()
      await flushMicrotasks()
    }
    this.#monotonicMs = targetMs
    await flushMicrotasks()
  }

  #nextDueTimer(targetMs: number): ScheduledTimer | undefined {
    let best: ScheduledTimer | undefined
    for (const timer of this.#timers.values()) {
      if (timer.dueAtMs > targetMs) {
        continue
      }
      if (
        best === undefined ||
        timer.dueAtMs < best.dueAtMs ||
        (timer.dueAtMs === best.dueAtMs && timer.sequence < best.sequence)
      ) {
        best = timer
      }
    }
    return best
  }
}

/** Lets already-queued promise jobs and I/O callbacks run. */
export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

function toHandle(id: number): TimerHandle {
  return id as unknown as TimerHandle
}

function fromHandle(handle: TimerHandle): number {
  return handle as unknown as number
}
