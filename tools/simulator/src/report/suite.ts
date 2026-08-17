import { BUILTIN_SCENARIOS, type Scenario } from '../scenario/index.js'
import { buildAdversarialScenario } from '../runner/adversarial.js'
import { openSession } from '../runner/session.js'
import {
  buildLatencyReport,
  fetchMetrics,
  type LatencyReport,
  type ScenarioReport,
} from './latency.js'

/**
 * The suite `npm run sim:report` plays.
 *
 * Scenarios that need a virtual clock are excluded: their whole point is to
 * cross hours of world time, and a report of *latency* has to run on the system
 * clock or the numbers are not latencies (spec §7.5, §11 엔진 지연). Those
 * scenarios are still covered — `npm run test:replay` runs all of them under the
 * virtual clock.
 */

export function reportScenarios(): Scenario[] {
  return [...BUILTIN_SCENARIOS, buildAdversarialScenario()].filter(
    (scenario) => !scenario.requiresVirtualClock,
  )
}

export interface RunReportOptions {
  readonly clock?: 'virtual' | 'system'
  /** Playback speed for the system clock; `0` posts as fast as accepted. */
  readonly speed?: number
  readonly scenarios?: readonly Scenario[]
  readonly onLog?: (line: string) => void
  /** Wall-clock instant for the report header, injected so output is testable. */
  readonly now?: () => string
}

/** Runs the suite against a fresh in-process backend and reports `/metrics`. */
export async function runLatencySuite(options: RunReportOptions = {}): Promise<LatencyReport> {
  const clock = options.clock ?? 'system'
  const scenarios = options.scenarios ?? reportScenarios()
  const session = await openSession({
    clock,
    ...(options.speed === undefined ? {} : { speed: options.speed }),
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  })
  const reports: ScenarioReport[] = []
  try {
    for (const scenario of scenarios) {
      const result = await session.run(scenario)
      reports.push({
        id: result.scenarioId,
        clock: result.clock,
        envelopesPosted: result.envelopesPosted,
        accepted: result.accepted,
        duplicates: result.duplicates,
        refusals: result.refusals,
        controlsSkipped: result.controlsSkipped,
        wallClockMs: result.wallClockMs,
      })
    }
    // Read the metrics over HTTP, exactly as an operator would (§T11: 서버
    // `/metrics`를 읽어 리포트 출력).
    const metrics = await fetchMetrics(session.harness.baseUrl)
    return buildLatencyReport({
      generatedAt: (options.now ?? (() => new Date().toISOString()))(),
      clock,
      target: `in-process ${session.harness.baseUrl}`,
      scenarios: reports,
      metrics,
    })
  } finally {
    await session.close()
  }
}

/**
 * Reports `/metrics` of a server that is already running (no injection).
 *
 * `clock` is the caller's, not a guess: an external server runs on the system
 * clock, but the CLI also prints this report after an in-process virtual-clock
 * run, and those durations are scenario time. Labelling them wrongly would put a
 * number that is not a latency under a heading that says it is (spec §7.5).
 */
export async function reportRunningServer(
  baseUrl: string,
  options: { readonly now?: () => string; readonly clock?: 'virtual' | 'system' } = {},
): Promise<LatencyReport> {
  const metrics = await fetchMetrics(baseUrl)
  return buildLatencyReport({
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    clock: options.clock ?? 'system',
    target: baseUrl,
    scenarios: [],
    metrics,
  })
}
