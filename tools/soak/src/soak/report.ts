import type { SoakMode, SoakThresholds } from '../config.js'

/**
 * The end-of-run report of TASK_SPECS §T15 ("종료 리포트(중단·복구 횟수, 상태·이벤트
 * 유실, freeze 카운터, p95)").
 *
 * Two kinds of statement live in it and they are kept apart on purpose:
 *
 * - **invariants** — things spec §2/§9.2/§11 state outright, which need no
 *   approved number to judge: an event received and then silently lost, an
 *   interruption that never recovered, a run that stopped itself. These always
 *   decide pass/fail, and each one carries the clause it comes from.
 * - **thresholds** — spec §11's approved pass line (최대 연속 중단시간,
 *   자동복구시간, freeze 허용치, alert 전달시간, p95, 가용률). Every one of them
 *   is `null` until Gate 0/2 locks it, and a `null` threshold is reported as
 *   `not-locked` rather than being invented (BOARD A-15).
 *
 * A report can therefore be `pass` while several measurements have no verdict.
 * That is the honest outcome before Gate 0, and the formatter says so in words.
 */

export type ThresholdOutcome = 'met' | 'exceeded' | 'not-locked'

export interface ThresholdCheck {
  readonly name: string
  readonly measured: number | null
  readonly threshold: number | null
  readonly outcome: ThresholdOutcome
  readonly unit: string
}

export interface InvariantCheck {
  readonly name: string
  readonly spec: string
  readonly measured: number
  readonly held: boolean
  readonly detail: string
}

export interface SoakInterruption {
  readonly atScenarioMs: number
  readonly state: string
  readonly reason: string
  readonly recoveredAtScenarioMs: number | null
  readonly durationMs: number | null
}

export interface SoakCounters {
  readonly slices: number
  readonly liveSlices: number
  readonly interactionEnabledSlices: number
  readonly envelopesPosted: number
  readonly envelopesInserted: number
  readonly injectionRefusals: number
  readonly processedIngestSeq: number
  readonly stateRevision: number
  readonly interruptions: number
  readonly recoveries: number
  readonly unrecoveredInterruptions: number
  readonly freezeEvents: number
  /**
   * Freezes that happened while a drill was deliberately holding the renderer's
   * context. Reported apart from the total so a Gate 0 freeze allowance is not
   * compared against frames the harness itself stopped.
   */
  readonly freezeEventsDuringInjection: number
  readonly backendRestarts: number
  readonly componentRestarts: Readonly<Record<string, number>>
  readonly faultsInjected: readonly string[]
  readonly alerts: Readonly<Record<string, number>>
  readonly safeStops: number
  readonly finalConsecutiveWriterFailures: number
}

export interface SoakLatency {
  readonly receivedToCommittedP95Ms: number | null
  readonly committedToPublishedP95Ms: number | null
  readonly publishedToAckedP95Ms: number | null
  readonly endToEndP95Ms: number | null
  readonly samples: number
}

export interface SoakReport {
  readonly generatedAt: string
  readonly mode: SoakMode
  readonly clock: 'virtual' | 'system'
  readonly scenarioMs: number
  readonly wallClockMs: number
  readonly finalState: string
  readonly counters: SoakCounters
  readonly interruptions: readonly SoakInterruption[]
  readonly latency: SoakLatency
  readonly maxContinuousOutageMs: number
  readonly maxRecoveryMs: number | null
  readonly broadcastAvailability: number
  readonly interactionAvailability: number
  readonly invariants: readonly InvariantCheck[]
  readonly thresholds: readonly ThresholdCheck[]
  readonly passed: boolean
  /** Config keys that still have no approved value (BOARD A-15). */
  readonly provisional: readonly string[]
}

export interface BuildSoakReportInput {
  readonly generatedAt: string
  readonly mode: SoakMode
  readonly scenarioMs: number
  readonly wallClockMs: number
  readonly finalState: string
  readonly counters: SoakCounters
  readonly interruptions: readonly SoakInterruption[]
  readonly latency: SoakLatency
  readonly maxContinuousOutageMs: number
  readonly maxRecoveryMs: number | null
  readonly thresholds: SoakThresholds
  readonly provisional: readonly string[]
}

export function buildSoakReport(input: BuildSoakReportInput): SoakReport {
  const { counters } = input
  const broadcastAvailability = counters.slices === 0 ? 0 : counters.liveSlices / counters.slices
  const interactionAvailability =
    counters.slices === 0 ? 0 : counters.interactionEnabledSlices / counters.slices

  const invariants: InvariantCheck[] = [
    {
      name: 'no_event_lost',
      spec: '§9.2 "degraded 동안 수신한 이벤트를 조용히 잃거나 이미 반영됐다고 표시하지 않는다"',
      measured: counters.envelopesInserted - counters.processedIngestSeq,
      held: counters.envelopesInserted === counters.processedIngestSeq,
      detail: `inserted=${String(counters.envelopesInserted)} processedIngestSeq=${String(counters.processedIngestSeq)}`,
    },
    {
      name: 'every_interruption_recovered',
      spec: '§11 무인성 "사람 조작 없이 콘텐츠·상태·송출이 계속되고"',
      measured: counters.unrecoveredInterruptions,
      held: counters.unrecoveredInterruptions === 0,
      detail: `interruptions=${String(counters.interruptions)} recoveries=${String(counters.recoveries)}`,
    },
    {
      name: 'no_unexpected_safe_stop',
      spec: '§11 안전 정지 (권리·정책·데이터 무결성 사건에서만)',
      measured: counters.safeStops,
      held: counters.safeStops === 0,
      detail: `finalState=${input.finalState}`,
    },
    {
      name: 'writer_not_wedged',
      spec: '§9.4(2) 마지막 commit 상태 전이 시각',
      measured: counters.finalConsecutiveWriterFailures,
      held: counters.finalConsecutiveWriterFailures === 0,
      detail: `stateRevision=${String(counters.stateRevision)}`,
    },
    {
      name: 'ends_live',
      spec: '§9.2 live 정의 (송출·chat listener·상태 tick·렌더러 heartbeat 모두 정상)',
      measured: input.finalState === 'live' ? 0 : 1,
      held: input.finalState === 'live',
      detail: `finalState=${input.finalState}`,
    },
  ]

  const thresholds: ThresholdCheck[] = [
    check(
      'maxContinuousOutageMs',
      input.maxContinuousOutageMs,
      input.thresholds.maxContinuousOutageMs,
      'ms',
      'max',
    ),
    check('maxRecoveryMs', input.maxRecoveryMs, input.thresholds.maxRecoveryMs, 'ms', 'max'),
    check('freezeEvents', counters.freezeEvents, input.thresholds.maxFreezeEvents, 'count', 'max'),
    check('alertDeliveryMs', null, input.thresholds.maxAlertDeliveryMs, 'ms', 'max'),
    check(
      'endToEndP95Ms',
      input.latency.endToEndP95Ms,
      input.thresholds.endToEndP95Ms,
      'ms',
      'max',
    ),
    check(
      'broadcastAvailability',
      broadcastAvailability,
      input.thresholds.minBroadcastAvailability,
      'ratio',
      'min',
    ),
    check(
      'interactionAvailability',
      interactionAvailability,
      input.thresholds.minInteractionAvailability,
      'ratio',
      'min',
    ),
  ]

  return {
    generatedAt: input.generatedAt,
    mode: input.mode,
    clock: input.mode === 'accelerated' ? 'virtual' : 'system',
    scenarioMs: input.scenarioMs,
    wallClockMs: input.wallClockMs,
    finalState: input.finalState,
    counters,
    interruptions: input.interruptions,
    latency: input.latency,
    maxContinuousOutageMs: input.maxContinuousOutageMs,
    maxRecoveryMs: input.maxRecoveryMs,
    broadcastAvailability,
    interactionAvailability,
    invariants,
    thresholds,
    passed:
      invariants.every((invariant) => invariant.held) &&
      thresholds.every((threshold) => threshold.outcome !== 'exceeded'),
    provisional: input.provisional,
  }
}

function check(
  name: string,
  measured: number | null,
  threshold: number | null,
  unit: string,
  direction: 'min' | 'max',
): ThresholdCheck {
  if (threshold === null || measured === null) {
    return { name, measured, threshold, outcome: 'not-locked', unit }
  }
  const met = direction === 'max' ? measured <= threshold : measured >= threshold
  return { name, measured, threshold, outcome: met ? 'met' : 'exceeded', unit }
}

const NO_PASS_LINE =
  'Thresholds marked not-locked have no approved value: spec §11 locks them at Gate 0/2 and this repository does not invent one (BOARD A-15). They are measured and reported, never judged.'

const VIRTUAL_CLOCK_WARNING =
  'WARNING: under the virtual clock every duration is scenario time, not measured latency. Run --mode realtime for numbers that mean milliseconds.'

export function formatSoakReport(report: SoakReport): string {
  const lines: string[] = []
  lines.push('vertical-live soak report (spec §11, TASK_SPECS §T15)')
  lines.push(`generated:  ${report.generatedAt}`)
  lines.push(`mode:       ${report.mode} (clock: ${report.clock})`)
  lines.push(
    `scenario:   ${formatDuration(report.scenarioMs)} in ${formatDuration(report.wallClockMs)} wall clock`,
  )
  lines.push(`final state: ${report.finalState}`)
  lines.push(`verdict:    ${report.passed ? 'PASS' : 'FAIL'}`)
  if (report.clock === 'virtual') {
    lines.push(VIRTUAL_CLOCK_WARNING)
  }
  lines.push('')

  lines.push('counters')
  lines.push(`  slices                    ${String(report.counters.slices)}`)
  lines.push(
    `  envelopes posted/inserted ${String(report.counters.envelopesPosted)}/${String(report.counters.envelopesInserted)}` +
      ` (refused ${String(report.counters.injectionRefusals)})`,
  )
  lines.push(`  processedIngestSeq        ${String(report.counters.processedIngestSeq)}`)
  lines.push(`  stateRevision             ${String(report.counters.stateRevision)}`)
  lines.push(
    `  interruptions/recoveries  ${String(report.counters.interruptions)}/${String(report.counters.recoveries)}`,
  )
  lines.push(
    `  freeze events             ${String(report.counters.freezeEvents)}` +
      ` (${String(report.counters.freezeEventsDuringInjection)} during an injected drill)`,
  )
  lines.push(`  backend restarts          ${String(report.counters.backendRestarts)}`)
  lines.push(`  safe stops                ${String(report.counters.safeStops)}`)
  const componentRestarts = Object.entries(report.counters.componentRestarts)
    .filter(([, count]) => count > 0)
    .map(([component, count]) => `${component}=${String(count)}`)
  lines.push(
    `  component restarts        ${componentRestarts.length === 0 ? 'none' : componentRestarts.join(' ')}`,
  )
  const alerts = Object.entries(report.counters.alerts).map(
    ([kind, count]) => `${kind}=${String(count)}`,
  )
  lines.push(`  alerts                    ${alerts.length === 0 ? 'none' : alerts.join(' ')}`)
  lines.push(
    `  faults injected           ${report.counters.faultsInjected.length === 0 ? 'none' : report.counters.faultsInjected.join(', ')}`,
  )
  lines.push('')

  lines.push('interruptions (spec §9.2 transitions out of `live`)')
  if (report.interruptions.length === 0) {
    lines.push('  none')
  } else {
    for (const interruption of report.interruptions) {
      lines.push(
        `  at ${formatDuration(interruption.atScenarioMs).padStart(9)}  ${interruption.state.padEnd(11)}` +
          ` ${interruption.reason.padEnd(44)} recovered ${
            interruption.durationMs === null
              ? 'NEVER'
              : `after ${formatDuration(interruption.durationMs)}`
          }`,
      )
    }
  }
  lines.push('')

  lines.push(`latency (${String(report.latency.samples)} samples, ${report.clock} clock)`)
  lines.push(`  received→committed p95    ${formatMs(report.latency.receivedToCommittedP95Ms)}`)
  lines.push(`  committed→published p95   ${formatMs(report.latency.committedToPublishedP95Ms)}`)
  lines.push(`  published→acked p95       ${formatMs(report.latency.publishedToAckedP95Ms)}`)
  lines.push(`  received→acked p95        ${formatMs(report.latency.endToEndP95Ms)}`)
  lines.push('')

  lines.push('invariants (always enforced)')
  for (const invariant of report.invariants) {
    lines.push(
      `  ${invariant.held ? 'ok  ' : 'FAIL'} ${invariant.name.padEnd(28)} ${invariant.detail}`,
    )
    lines.push(`       ${invariant.spec}`)
  }
  lines.push('')

  lines.push('thresholds (spec §11 pass line)')
  for (const threshold of report.thresholds) {
    lines.push(
      `  ${threshold.outcome.padEnd(10)} ${threshold.name.padEnd(24)}` +
        ` measured=${threshold.measured === null ? '—' : formatNumber(threshold.measured)}` +
        ` threshold=${threshold.threshold === null ? 'not locked' : formatNumber(threshold.threshold)}` +
        ` ${threshold.unit}`,
    )
  }
  lines.push('')
  lines.push(NO_PASS_LINE)
  if (report.provisional.length > 0) {
    lines.push(`provisional config keys: ${report.provisional.join(', ')}`)
  }
  return lines.join('\n')
}

function formatDuration(millis: number): string {
  if (millis < 1000) return `${String(Math.round(millis))}ms`
  const seconds = millis / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  return `${(minutes / 60).toFixed(2)}h`
}

function formatMs(value: number | null): string {
  return value === null ? '—' : value.toFixed(1)
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}
