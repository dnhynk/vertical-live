import type { Clock, TimerHandle } from '@vl/server'

/**
 * The virtual clock of TASK_SPECS §T11 acceptance 1: every scenario runs without
 * waiting for real time.
 *
 * It is the `Clock` of spec §10.2, so the store, the engine and the input
 * arbiter all read time from here — a 24-hour idle window costs a loop, not a
 * day. `advance()` fires due timers in order and yields to the event loop
 * between them, so HTTP and WebSocket callbacks scheduled by a timer have run by
 * the time it resolves.
 *
 * `nowUtcIso()` is an absolute UTC instant (spec §10.2) built from a fixed,
 * obviously synthetic epoch; `monotonicMs()` is the elapsed reading intervals
 * are measured with.
 */

/** 2026-08-16T00:00:00.000Z — a fixed synthetic epoch, not "now". */
export const VIRTUAL_EPOCH_MS = Date.UTC(2026, 7, 16, 0, 0, 0)

interface ScheduledTimer {
  readonly id: number
  readonly dueAtMs: number
  readonly sequence: number
  readonly handler: () => void
}

export interface VirtualClockOptions {
  readonly epochMs?: number
}

export class VirtualClock implements Clock {
  readonly #epochMs: number
  #elapsedMs = 0
  #timers = new Map<number, ScheduledTimer>()
  #nextId = 1
  #sequence = 0

  constructor(options: VirtualClockOptions = {}) {
    this.#epochMs = options.epochMs ?? VIRTUAL_EPOCH_MS
  }

  nowUtcIso(): string {
    return new Date(this.#epochMs + this.#elapsedMs).toISOString()
  }

  monotonicMs(): number {
    return this.#elapsedMs
  }

  get elapsedMs(): number {
    return this.#elapsedMs
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    const id = this.#nextId++
    this.#timers.set(id, {
      id,
      dueAtMs: this.#elapsedMs + delayMs,
      sequence: this.#sequence++,
      handler,
    })
    return id as unknown as TimerHandle
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as unknown as number)
  }

  async advance(deltaMs: number): Promise<void> {
    if (deltaMs < 0) throw new RangeError('virtual clock cannot go backwards')
    const targetMs = this.#elapsedMs + deltaMs
    for (;;) {
      const next = this.#nextDue(targetMs)
      if (next === undefined) break
      this.#elapsedMs = next.dueAtMs
      this.#timers.delete(next.id)
      next.handler()
      await flushEventLoop()
    }
    this.#elapsedMs = targetMs
    await flushEventLoop()
  }

  #nextDue(targetMs: number): ScheduledTimer | undefined {
    let best: ScheduledTimer | undefined
    for (const timer of this.#timers.values()) {
      if (timer.dueAtMs > targetMs) continue
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

/** Lets queued promise jobs and I/O callbacks run before time moves again. */
export async function flushEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}
