import type { EngineMetricsSnapshot, LatencySummary } from '@vl/server'

/**
 * The per-stage latency report of TASK_SPECS §T11 acceptance 2.
 *
 * It reads `GET /metrics`, which measures the four legs spec §7.3(8) requires be
 * measured **separately**, and prints count/p50/p95/max for each. It applies no
 * pass line: spec §7.5 locks the p95 threshold only after the Gate 2 calibration
 * on a real Japanese mobile device, and BOARD A-15 keeps such numbers out of the
 * code until then. A report that judged its own numbers would be inventing the
 * threshold this project has explicitly refused to invent.
 *
 * The clock is part of the report. Under a virtual clock the four numbers are
 * differences between *virtual* instants — useful for showing the ordering is
 * right, useless as latency — so the header says which clock produced them.
 */

export const LATENCY_STAGES = [
  { key: 'receivedToCommitted', label: 'API received → state committed' },
  { key: 'committedToPublished', label: 'state committed → published' },
  { key: 'publishedToAcked', label: 'published → renderer ACK' },
  { key: 'receivedToAcked', label: 'API received → renderer ACK (end to end)' },
] as const

export type LatencyStageKey = (typeof LATENCY_STAGES)[number]['key']

export interface StageReport extends LatencySummary {
  readonly key: LatencyStageKey
  readonly label: string
}

export interface ScenarioReport {
  readonly id: string
  readonly clock: 'virtual' | 'system'
  readonly envelopesPosted: number
  readonly accepted: number
  readonly duplicates: number
  readonly refusals: readonly string[]
  readonly controlsSkipped: readonly string[]
  readonly wallClockMs: number
}

export interface LatencyReport {
  readonly generatedAt: string
  readonly clock: 'virtual' | 'system'
  readonly target: string
  readonly scenarios: readonly ScenarioReport[]
  readonly stages: readonly StageReport[]
  readonly counters: Readonly<Record<string, number>>
}

export interface BuildReportInput {
  readonly generatedAt: string
  readonly clock: 'virtual' | 'system'
  readonly target: string
  readonly scenarios: readonly ScenarioReport[]
  readonly metrics: EngineMetricsSnapshot
}

export function buildLatencyReport(input: BuildReportInput): LatencyReport {
  return {
    generatedAt: input.generatedAt,
    clock: input.clock,
    target: input.target,
    scenarios: input.scenarios,
    stages: LATENCY_STAGES.map((stage) => ({
      key: stage.key,
      label: stage.label,
      ...input.metrics.latencyMs[stage.key],
    })),
    counters: input.metrics.counters,
  }
}

/** Reads `GET /metrics` from a running server (TASK_SPECS 공통 규약). */
export async function fetchMetrics(baseUrl: string): Promise<EngineMetricsSnapshot> {
  const response = await fetch(`${baseUrl}/metrics`)
  if (!response.ok) {
    throw new Error(`GET ${baseUrl}/metrics returned ${String(response.status)}`)
  }
  return (await response.json()) as EngineMetricsSnapshot
}

const NO_PASS_LINE =
  'No pass line is applied: spec §7.5 locks the p95 threshold after the Gate 2 calibration (BOARD A-15).'

export function formatLatencyReport(report: LatencyReport): string {
  const lines: string[] = []
  lines.push('vertical-live simulator — latency report (spec §7.3(8), §7.5)')
  lines.push(`generated: ${report.generatedAt}`)
  lines.push(`target:    ${report.target}`)
  lines.push(`clock:     ${report.clock}`)
  if (report.clock === 'virtual') {
    lines.push(
      'WARNING: virtual-clock durations are scenario time, not latency. Run with --clock system for measurable numbers.',
    )
  }
  lines.push('')

  if (report.scenarios.length > 0) {
    lines.push('scenarios')
    for (const scenario of report.scenarios) {
      const notes: string[] = []
      if (scenario.refusals.length > 0) notes.push(`refused=${scenario.refusals.join(',')}`)
      if (scenario.controlsSkipped.length > 0) {
        notes.push(`controls skipped=${scenario.controlsSkipped.join(',')}`)
      }
      lines.push(
        `  ${scenario.id.padEnd(18)} posted=${String(scenario.envelopesPosted).padStart(5)}` +
          ` accepted=${String(scenario.accepted).padStart(5)}` +
          ` duplicates=${String(scenario.duplicates).padStart(4)}` +
          ` wall=${String(scenario.wallClockMs).padStart(6)}ms` +
          (notes.length === 0 ? '' : `  [${notes.join('; ')}]`),
      )
    }
    lines.push('')
  }

  lines.push(
    `${'stage'.padEnd(42)}${'count'.padStart(7)}${'p50 ms'.padStart(10)}${'p95 ms'.padStart(10)}${'max ms'.padStart(10)}`,
  )
  for (const stage of report.stages) {
    lines.push(
      stage.label.padEnd(42) +
        String(stage.count).padStart(7) +
        formatMs(stage.p50Ms).padStart(10) +
        formatMs(stage.p95Ms).padStart(10) +
        formatMs(stage.maxMs).padStart(10),
    )
  }
  lines.push('')

  const counters = Object.entries(report.counters)
  if (counters.length > 0) {
    lines.push('counters')
    for (const [name, value] of counters) {
      lines.push(`  ${name.padEnd(40)}${String(value).padStart(8)}`)
    }
    lines.push('')
  }

  lines.push(NO_PASS_LINE)
  return lines.join('\n')
}

/** `—` for a stage with no samples: an absent measurement is not a zero. */
function formatMs(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}
