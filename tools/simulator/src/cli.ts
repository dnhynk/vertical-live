import { readFile } from 'node:fs/promises'

import { parseScenario, planScenario, requiresParser, type Scenario } from './scenario/index.js'
import { BUILTIN_SCENARIOS, findBuiltinScenario } from './scenario/catalog.js'
import {
  ADVERSARIAL_SCENARIO_ID,
  buildAdversarialScenario,
  simulatorCommandParser,
} from './runner/adversarial.js'
import { openSession } from './runner/session.js'
import type { InjectTarget } from './runner/inject.js'
import { runScenario } from './runner/run.js'
import { formatLatencyReport, reportRunningServer, runLatencySuite } from './report/index.js'

export const USAGE = `vl-simulator — @vl/simulator (TASK_SPECS §T11)

Usage:
  vl-simulator list                         List the built-in scenarios
  vl-simulator run <id|path> [options]      Play a scenario
  vl-simulator report [options]             Per-stage p50/p95 from GET /metrics
  vl-simulator help                         Show this message

run options:
  --clock virtual|system   Virtual (default) needs the in-process backend
  --slice-ms <n>           Virtual-clock slice, default 60000
  --url <base>             Play against a server that is already running
                           (system clock; requires --token)
  --token <value>          Bearer token for POST /ingest/simulator
  --speed <n>              System-clock playback speed; 0 (default) = no waiting
  --json                   Print the run result as JSON

report options:
  --url <base>             Report a running server's /metrics instead of
                           playing the built-in suite in process
  --clock virtual|system   Clock for the in-process suite, default system
  --json                   Print the report as JSON

Injection always goes through POST /ingest/simulator. The endpoint answers 404
while simulator.enabled is false (spec §T11 acceptance 3).`

export interface CliResult {
  readonly exitCode: number
  readonly output: string
}

const HELP_COMMANDS = new Set(['help', '--help', '-h'])

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const command = argv[0]
  if (command === undefined || HELP_COMMANDS.has(command)) {
    return { exitCode: 0, output: USAGE }
  }
  try {
    switch (command) {
      case 'list':
        return listCommand()
      case 'run':
        return await runCommand(argv.slice(1))
      case 'report':
        return await reportCommand(argv.slice(1))
      default:
        return { exitCode: 2, output: `unknown command: ${command}\n\n${USAGE}` }
    }
  } catch (error) {
    return { exitCode: 1, output: `error: ${error instanceof Error ? error.message : 'unknown'}` }
  }
}

/** Every scenario the CLI can play: the browser-safe catalog plus adversarial. */
export function allScenarios(): Scenario[] {
  return [...BUILTIN_SCENARIOS, buildAdversarialScenario()]
}

function listCommand(): CliResult {
  const lines = allScenarios().map((scenario) => {
    const flags = [
      scenario.requiresVirtualClock ? 'virtual-clock' : null,
      requiresParser(scenario) ? 'needs-parser' : null,
    ].filter((flag): flag is string => flag !== null)
    return `${scenario.id.padEnd(18)} ${scenario.title.padEnd(28)}${flags.length === 0 ? '' : `[${flags.join(', ')}]`}\n  ${scenario.summary}`
  })
  return { exitCode: 0, output: lines.join('\n\n') }
}

async function loadScenario(reference: string): Promise<Scenario> {
  if (reference === ADVERSARIAL_SCENARIO_ID) return buildAdversarialScenario()
  const builtin = findBuiltinScenario(reference)
  if (builtin !== null) return builtin
  const raw = await readFile(reference, 'utf8')
  return parseScenario(JSON.parse(raw))
}

async function runCommand(argv: readonly string[]): Promise<CliResult> {
  const reference = argv[0]
  if (reference === undefined || reference.startsWith('--')) {
    return { exitCode: 2, output: `run needs a scenario id or file path\n\n${USAGE}` }
  }
  const flags = parseFlags(argv.slice(1))
  const scenario = await loadScenario(reference)
  const json = flags.has('json')
  const url = flags.get('url')

  if (url !== undefined) {
    // An external server owns its own clock; the simulator can only post.
    const token = flags.get('token')
    if (token === undefined) {
      return { exitCode: 2, output: 'error: --url also needs --token (the vault bearer token)' }
    }
    if (scenario.requiresVirtualClock) {
      return {
        exitCode: 2,
        output: `error: ${scenario.id} needs a virtual clock and cannot run against --url`,
      }
    }
    const target: InjectTarget = { baseUrl: url, token }
    const plan = planScenario(
      scenario,
      requiresParser(scenario) ? { parseCommand: simulatorCommandParser() } : {},
    )
    const result = await runScenario({
      plan,
      target,
      speed: readNumber(flags.get('speed'), 0),
    })
    return { exitCode: result.refusals.length === 0 ? 0 : 1, output: format(result, json) }
  }

  const clock = flags.get('clock') === 'system' ? 'system' : 'virtual'
  const session = await openSession({
    clock,
    sliceMs: readNumber(flags.get('slice-ms'), 60_000),
    speed: readNumber(flags.get('speed'), 0),
  })
  try {
    const result = await session.run(scenario)
    const summary = json
      ? JSON.stringify({ ...result, health: session.harness.engine.health() }, null, 2)
      : `${format(result, false)}\n\n${formatLatencyReport(
          await reportRunningServer(session.harness.baseUrl, { clock }),
        )}`
    return { exitCode: result.refusals.length === 0 ? 0 : 1, output: summary }
  } finally {
    await session.close()
  }
}

async function reportCommand(argv: readonly string[]): Promise<CliResult> {
  const flags = parseFlags(argv)
  const json = flags.has('json')
  const url = flags.get('url')
  const report =
    url === undefined
      ? await runLatencySuite({
          clock: flags.get('clock') === 'virtual' ? 'virtual' : 'system',
          speed: readNumber(flags.get('speed'), 0),
        })
      : await reportRunningServer(url)
  return {
    exitCode: 0,
    output: json ? JSON.stringify(report, null, 2) : formatLatencyReport(report),
  }
}

function format(result: unknown, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2)
  const value = result as Record<string, unknown>
  return Object.entries(value)
    .map(([key, entry]) => `${key.padEnd(18)}${formatValue(entry)}`)
    .join('\n')
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ')
  return String(value)
}

/** `--flag value` and `--flag`; unknown flags are reported, not ignored. */
export function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, '')
      continue
    }
    flags.set(name, next)
    index += 1
  }
  return flags
}

function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`not a number: ${value}`)
  return parsed
}
