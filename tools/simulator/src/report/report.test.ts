import type { EngineMetricsSnapshot } from '@vl/server'
import { describe, expect, it } from 'vitest'

import { buildLatencyReport, formatLatencyReport, LATENCY_STAGES } from './latency.js'
import { reportScenarios, runLatencySuite } from './suite.js'

/**
 * The report of TASK_SPECS §T11 acceptance 2: per-stage p50/p95 read from
 * `GET /metrics`, with no pass line applied (spec §7.5, BOARD A-15).
 */

const metrics: EngineMetricsSnapshot = {
  latencyMs: {
    receivedToCommitted: { count: 4, p50Ms: 1, p95Ms: 4, maxMs: 4 },
    committedToPublished: { count: 4, p50Ms: 0, p95Ms: 1, maxMs: 1 },
    publishedToAcked: { count: 3, p50Ms: 2, p95Ms: 6, maxMs: 6 },
    receivedToAcked: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
  },
  counters: { commit: 12, paid_applied: 2 },
}

describe('buildLatencyReport', () => {
  it('keeps the four legs of spec §7.3(8) separate', () => {
    const report = buildLatencyReport({
      generatedAt: '2026-08-17T00:00:00.000Z',
      clock: 'system',
      target: 'in-process http://127.0.0.1:1',
      scenarios: [],
      metrics,
    })

    expect(report.stages.map((stage) => stage.key)).toEqual(LATENCY_STAGES.map((s) => s.key))
    expect(report.stages[0]).toMatchObject({ count: 4, p50Ms: 1, p95Ms: 4 })
  })
})

describe('formatLatencyReport', () => {
  it('prints a p95 for every stage and states that there is no pass line', () => {
    const text = formatLatencyReport(
      buildLatencyReport({
        generatedAt: '2026-08-17T00:00:00.000Z',
        clock: 'system',
        target: 'in-process http://127.0.0.1:1',
        scenarios: [],
        metrics,
      }),
    )

    expect(text).toContain('p95 ms')
    expect(text).toContain('API received → renderer ACK (end to end)')
    expect(text).toContain('No pass line is applied')
    expect(text).toContain('§7.5')
    // A stage with no samples reports an absence, not a zero.
    expect(text).toContain('—')
    expect(text).not.toContain('WARNING')
  })

  it('warns that virtual-clock numbers are not latency', () => {
    const text = formatLatencyReport(
      buildLatencyReport({
        generatedAt: '2026-08-17T00:00:00.000Z',
        clock: 'virtual',
        target: 'in-process http://127.0.0.1:1',
        scenarios: [],
        metrics,
      }),
    )

    expect(text).toContain('WARNING: virtual-clock durations are scenario time, not latency')
  })

  it('names a scenario whose control steps were skipped', () => {
    const text = formatLatencyReport(
      buildLatencyReport({
        generatedAt: '2026-08-17T00:00:00.000Z',
        clock: 'system',
        target: 'x',
        scenarios: [
          {
            id: 'degraded-window',
            clock: 'system',
            envelopesPosted: 3,
            accepted: 3,
            duplicates: 0,
            refusals: [],
            controlsSkipped: ['degrade'],
            wallClockMs: 12,
          },
        ],
        metrics,
      }),
    )

    expect(text).toContain('controls skipped=degrade')
  })
})

describe('reportScenarios', () => {
  it('excludes the virtual-clock scenarios, whose durations are not latency', () => {
    const ids = reportScenarios().map((scenario) => scenario.id)

    expect(ids).not.toContain('idle-24h')
    expect(ids).not.toContain('degraded-window')
    expect(ids).toContain('paid-replay')
    expect(ids).toContain('adversarial')
  })
})

describe('runLatencySuite', () => {
  it('plays the suite against a real backend and reports measured stages', async () => {
    const report = await runLatencySuite({
      clock: 'system',
      now: () => '2026-08-17T00:00:00.000Z',
    })

    expect(report.clock).toBe('system')
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual(
      reportScenarios().map((scenario) => scenario.id),
    )
    expect(report.scenarios.every((scenario) => scenario.refusals.length === 0)).toBe(true)
    // The end-to-end leg is the §11 "엔진 지연" one; it must have samples, or the
    // report would be silently covering only the server half.
    const endToEnd = report.stages.find((stage) => stage.key === 'receivedToAcked')
    expect(endToEnd?.count).toBeGreaterThan(0)
    expect(endToEnd?.p95Ms).not.toBeNull()
    expect(formatLatencyReport(report)).toContain('p95 ms')
  }, 180_000)
})
