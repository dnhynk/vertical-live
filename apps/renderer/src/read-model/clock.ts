import type { IsoUtcInstant } from '@vl/contract'

/**
 * Injected time source (CLAUDE.md §4: time-dependent code takes a `Clock`).
 *
 * Two separate readings, as spec §10.2 requires: intervals (backoff, FPS,
 * effect windows) are measured with a monotonic clock, while the `appliedAt`
 * that leaves the renderer on an ACK is an absolute UTC instant.
 */
export interface Clock {
  /** Monotonic milliseconds; only differences are meaningful. */
  monotonicMs(): number
  /**
   * Wall-clock milliseconds since the epoch, used only to compare the absolute
   * `startsAt`/`endsAt` deadlines the server puts on an effect. V1 runs the
   * server and the renderer on one host (spec §10.2), so no skew correction is
   * attempted here.
   */
  wallMs(): number
  /** Absolute UTC instant, ISO 8601 with `Z`. */
  nowIso(): IsoUtcInstant
}

export const systemClock: Clock = {
  monotonicMs: () => performance.now(),
  wallMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
}
