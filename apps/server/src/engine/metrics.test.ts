import { describe, expect, it } from 'vitest'

import { EngineMetrics, LatencyHistogram } from './metrics.js'

/** The instrumentation of spec §7.3(8): four legs, measured separately. */

describe('LatencyHistogram', () => {
  it('reports nothing until it has a sample', () => {
    expect(new LatencyHistogram(8).summary()).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    })
  })

  it('computes nearest-rank percentiles', () => {
    const histogram = new LatencyHistogram(100)
    for (let value = 1; value <= 100; value += 1) histogram.record(value)

    expect(histogram.summary()).toEqual({ count: 100, p50Ms: 50, p95Ms: 95, maxMs: 100 })
  })

  it('keeps the most recent samples and the total count', () => {
    const histogram = new LatencyHistogram(3)
    for (const value of [100, 200, 300, 1, 2, 3]) histogram.record(value)

    const summary = histogram.summary()
    expect(summary.count).toBe(6)
    expect(summary.maxMs).toBe(3)
  })

  it('ignores a sample from a clock that went backwards', () => {
    const histogram = new LatencyHistogram(4)
    histogram.record(-5)
    histogram.record(Number.NaN)

    expect(histogram.summary().count).toBe(0)
  })

  it('refuses a nonsensical capacity', () => {
    expect(() => new LatencyHistogram(0)).toThrow(RangeError)
  })
})

describe('EngineMetrics', () => {
  it('measures the reception, publication and ACK legs of one event', () => {
    const metrics = new EngineMetrics(64)
    metrics.recordCommit(5, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.200Z')
    metrics.recordSnapshotPublish(5, '2026-08-16T00:00:00.250Z')
    metrics.recordPublish('e5_0', '2026-08-16T00:00:00.200Z', '2026-08-16T00:00:00.250Z')
    metrics.recordStateAck(5, '2026-08-16T00:00:00.900Z')
    metrics.recordEffectAck('e5_0', '2026-08-16T00:00:00.800Z')

    const snapshot = metrics.snapshot()
    expect(snapshot.latencyMs.receivedToCommitted.p95Ms).toBe(200)
    expect(snapshot.latencyMs.committedToPublished.p95Ms).toBe(50)
    expect(snapshot.latencyMs.publishedToAcked.p95Ms).toBe(550)
    expect(snapshot.latencyMs.receivedToAcked.p95Ms).toBe(900)
  })

  it('does not invent a reception instant for a timer-caused revision', () => {
    const metrics = new EngineMetrics(64)
    metrics.recordCommit(2, null, '2026-08-16T00:00:00.000Z')
    metrics.recordStateAck(2, '2026-08-16T00:00:00.100Z')

    const snapshot = metrics.snapshot()
    expect(snapshot.latencyMs.receivedToCommitted.count).toBe(0)
    expect(snapshot.latencyMs.receivedToAcked.count).toBe(0)
  })

  it('ignores an ACK for something it never saw published', () => {
    const metrics = new EngineMetrics(64)
    metrics.recordEffectAck('e99_0', '2026-08-16T00:00:00.100Z')
    metrics.recordStateAck(99, '2026-08-16T00:00:00.100Z')

    expect(metrics.snapshot().latencyMs.publishedToAcked.count).toBe(0)
  })

  it('sorts counters so the /metrics body is stable', () => {
    const metrics = new EngineMetrics(8)
    metrics.count('zulu')
    metrics.count('alpha', 3)

    expect(Object.keys(metrics.snapshot().counters)).toEqual(['alpha', 'zulu'])
    expect(metrics.snapshot().counters['alpha']).toBe(3)
  })
})
