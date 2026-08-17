/**
 * Health signal contract (spec §9.4). Producers (T2 OBS, T9 chat transport, T5
 * renderer, …) only *report*: they never decide that the system is degraded.
 * T12's supervisor aggregates these into the `offline → starting → live →
 * degraded → recovering → live | safe_stopped` state machine.
 */

export type HealthStatus =
  /** Observed and within the producer's expectation. */
  | 'ok'
  /** Observed and outside expectation; the aggregator decides what it means. */
  | 'degraded'
  /** The producer could not observe the thing at all (e.g. no connection). */
  | 'unknown'

/** The component a signal belongs to. Extended as later tasks add producers. */
export type HealthComponent = 'obs' | 'youtube' | 'youtube-chat'

/** Detail values stay primitive so signals can be serialized to `/health` as-is. */
export type HealthDetailValue = string | number | boolean | null

export interface HealthSignal {
  readonly component: HealthComponent
  /** Stable identifier, e.g. `obs.stream`. Unique per component. */
  readonly name: string
  readonly status: HealthStatus
  /** Absolute observation instant, UTC ISO 8601 (spec §10.2). */
  readonly observedAtUtc: string
  /** Monotonic reading of the same observation, for interval math (spec §10.2). */
  readonly observedAtMonotonicMs: number
  /** Short machine-stable reason, present whenever status is not `ok`. */
  readonly reason?: string
  readonly detail: Readonly<Record<string, HealthDetailValue>>
}

export type HealthSignalSink = (signal: HealthSignal) => void
