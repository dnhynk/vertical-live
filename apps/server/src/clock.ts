/**
 * Injectable clock (spec §10.2): persisted instants are absolute UTC ISO 8601,
 * elapsed intervals are measured with a monotonic source. Every time-dependent
 * module takes a `Clock` so tests (and T11's virtual clock) stay deterministic.
 */
export interface Clock {
  /** Absolute instant for persistence and reporting. */
  nowUtcIso(): string
  /** Monotonic milliseconds; only differences between readings are meaningful. */
  monotonicMs(): number
  setTimeout(handler: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

declare const timerHandleBrand: unique symbol

/** Opaque timer identity so callers cannot depend on the host timer type. */
export type TimerHandle = { readonly [timerHandleBrand]: true }

export const systemClock: Clock = {
  nowUtcIso: () => new Date().toISOString(),
  monotonicMs: () => Number(process.hrtime.bigint()) / 1e6,
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs) as unknown as TimerHandle,
  clearTimeout: (handle) => {
    clearTimeout(handle as unknown as NodeJS.Timeout)
  },
}
