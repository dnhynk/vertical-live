/**
 * Latency instrumentation of spec §7.3(8) and §7.5.
 *
 * The four legs spec §7.3(8) asks to be measured *separately* are kept
 * separately: `receivedAt → committedAt`, `committedAt → publishedAt`,
 * `publishedAt → ackedAt`, plus the end-to-end `receivedAt → ackedAt` the
 * "API 수신 → renderer 확인" pass line of spec §11 is stated over.
 *
 * There is no pass line in here on purpose. Spec §7.5 says the p95 threshold is
 * locked only after the Gate 2 calibration, so this module measures and reports
 * and never judges (BOARD A-15).
 *
 * Samples are milliseconds between two absolute UTC instants. Elapsed intervals
 * inside one process are measured monotonically (spec §10.2), but these four
 * legs cross the process boundary — the renderer stamps `appliedAt` — so the
 * absolute instants are the only common base.
 */

export interface LatencySummary {
  readonly count: number
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly maxMs: number | null
}

/** Bounded reservoir: the most recent `capacity` samples, exact percentiles. */
export class LatencyHistogram {
  readonly #capacity: number
  #samples: number[] = []
  #count = 0

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `latency histogram capacity must be a positive integer: ${String(capacity)}`,
      )
    }
    this.#capacity = capacity
  }

  /** Ignores a negative sample: a clock that went backwards is not a latency. */
  record(millis: number): void {
    if (!Number.isFinite(millis) || millis < 0) return
    this.#count += 1
    this.#samples.push(millis)
    if (this.#samples.length > this.#capacity) this.#samples.shift()
  }

  summary(): LatencySummary {
    if (this.#samples.length === 0) {
      return { count: this.#count, p50Ms: null, p95Ms: null, maxMs: null }
    }
    const sorted = [...this.#samples].sort((a, b) => a - b)
    return {
      count: this.#count,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted[sorted.length - 1] as number,
    }
  }
}

/** Nearest-rank percentile; with one sample every percentile is that sample. */
function percentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] as number
}

export interface EngineMetricsSnapshot {
  readonly latencyMs: {
    readonly receivedToCommitted: LatencySummary
    readonly committedToPublished: LatencySummary
    readonly publishedToAcked: LatencySummary
    readonly receivedToAcked: LatencySummary
  }
  readonly counters: Readonly<Record<string, number>>
}

/**
 * Counters and histograms of one engine. Counter names are stable machine
 * tokens; none of them can carry a message, an author or a chat line.
 */
export class EngineMetrics {
  readonly #receivedToCommitted: LatencyHistogram
  readonly #committedToPublished: LatencyHistogram
  readonly #publishedToAcked: LatencyHistogram
  readonly #receivedToAcked: LatencyHistogram
  readonly #counters = new Map<string, number>()
  /** `receivedAt` of the event that caused a revision, for the ACK leg. */
  readonly #revisionOrigin = new Map<number, { receivedAt: string | null; committedAt: string }>()
  readonly #effectOrigin = new Map<string, { receivedAt: string | null; publishedAt: string }>()

  constructor(sampleSize: number) {
    this.#receivedToCommitted = new LatencyHistogram(sampleSize)
    this.#committedToPublished = new LatencyHistogram(sampleSize)
    this.#publishedToAcked = new LatencyHistogram(sampleSize)
    this.#receivedToAcked = new LatencyHistogram(sampleSize)
  }

  count(name: string, delta = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + delta)
  }

  /**
   * One committed transition. `receivedAt` is `null` for a transition a timer
   * caused: there is no API reception to measure against, and inventing one
   * would put a made-up number into the §7.5 report.
   */
  recordCommit(revision: number, receivedAt: string | null, committedAt: string): void {
    if (receivedAt !== null)
      this.#receivedToCommitted.record(millisBetween(receivedAt, committedAt))
    this.#revisionOrigin.set(revision, { receivedAt, committedAt })
    this.#trim(this.#revisionOrigin)
  }

  recordPublish(effectId: string, committedAt: string, publishedAt: string): void {
    this.#committedToPublished.record(millisBetween(committedAt, publishedAt))
    this.#effectOrigin.set(effectId, { receivedAt: null, publishedAt })
    this.#trim(this.#effectOrigin)
  }

  recordSnapshotPublish(revision: number, publishedAt: string): void {
    const origin = this.#revisionOrigin.get(revision)
    if (origin === undefined) return
    this.#committedToPublished.record(millisBetween(origin.committedAt, publishedAt))
  }

  /** `ack_state`: the renderer drew this revision (spec §7.3(7)). */
  recordStateAck(revision: number, appliedAt: string): void {
    const origin = this.#revisionOrigin.get(revision)
    // A timer-caused revision has no API reception to measure from, and putting
    // the commit instant there would quietly deflate the §7.5 end-to-end p95.
    if (origin?.receivedAt == null) return
    this.#receivedToAcked.record(millisBetween(origin.receivedAt, appliedAt))
  }

  /** `ack_effect`: the renderer played this effect on a real frame. */
  recordEffectAck(effectId: string, appliedAt: string): void {
    const origin = this.#effectOrigin.get(effectId)
    if (origin === undefined) return
    this.#publishedToAcked.record(millisBetween(origin.publishedAt, appliedAt))
  }

  snapshot(): EngineMetricsSnapshot {
    return {
      latencyMs: {
        receivedToCommitted: this.#receivedToCommitted.summary(),
        committedToPublished: this.#committedToPublished.summary(),
        publishedToAcked: this.#publishedToAcked.summary(),
        receivedToAcked: this.#receivedToAcked.summary(),
      },
      counters: Object.fromEntries([...this.#counters.entries()].sort()),
    }
  }

  /** Keeps the correlation tables bounded; a 24/7 process must not grow one. */
  #trim(table: Map<unknown, unknown>): void {
    const limit = 4096
    while (table.size > limit) {
      const oldest = table.keys().next()
      if (oldest.done === true) return
      table.delete(oldest.value)
    }
  }
}

function millisBetween(from: string, to: string): number {
  return Date.parse(to) - Date.parse(from)
}
