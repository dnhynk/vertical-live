import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadSoakConfig, type SoakMode } from './config.js'
import { FAULT_MATRIX_DOC_PATH, renderFaultMatrixDoc } from './matrix/doc.js'
import { formatSoakReport } from './soak/report.js'
import { runSoak } from './soak/run.js'

/**
 * `vl-soak` (TASK_SPECS §T15).
 *
 * Two verbs, and nothing else:
 *
 * - `matrix` prints the generated `docs/ops/fault-matrix.md`; `--write` puts it
 *   on disk. The document is a build product of `matrix/rows.ts` (CLAUDE.md §4);
 * - `run` executes the soak in one of the two clock modes and prints the report.
 *   `--report <file>` also writes the JSON, which is what an operator attaches to
 *   the Gate 2 record.
 */

export const USAGE = `usage:
  vl-soak matrix [--write]
  vl-soak run [--mode accelerated|realtime] [--duration-ms <n>] [--slice-ms <n>]
               [--no-faults] [--report <file>] [--quiet]

  matrix   render docs/ops/fault-matrix.md from tools/soak/src/matrix/rows.ts
  run      run the soak harness and print the end report

  --mode         accelerated (virtual clock, what CI runs) or realtime (host)
  --duration-ms  override the configured scenario duration
  --slice-ms     override the supervisor evaluation cadence
  --no-faults    run the load without the recoverable fault schedule
  --report       write the report JSON to this path
  --quiet        suppress the per-fault progress log`

export interface CliFlags {
  readonly command: 'matrix' | 'run' | 'help'
  readonly write: boolean
  readonly mode: SoakMode
  readonly durationMs: number | null
  readonly sliceMs: number | null
  readonly faults: boolean
  readonly reportPath: string | null
  readonly quiet: boolean
}

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

export function parseFlags(argv: readonly string[]): CliFlags {
  let command: CliFlags['command'] = 'help'
  let write = false
  let mode: SoakMode = 'accelerated'
  let durationMs: number | null = null
  let sliceMs: number | null = null
  let faults = true
  let reportPath: string | null = null
  let quiet = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string
    switch (argument) {
      case 'matrix':
      case 'run':
        command = argument
        break
      case 'help':
      case '--help':
      case '-h':
        command = 'help'
        break
      case '--write':
        write = true
        break
      case '--no-faults':
        faults = false
        break
      case '--quiet':
        quiet = true
        break
      case '--mode': {
        const value = argv[++index]
        if (value !== 'accelerated' && value !== 'realtime') {
          throw new CliError(`--mode must be accelerated or realtime, got ${String(value)}`)
        }
        mode = value
        break
      }
      case '--duration-ms':
        durationMs = readInt(argv[++index], '--duration-ms')
        break
      case '--slice-ms':
        sliceMs = readInt(argv[++index], '--slice-ms')
        break
      case '--report': {
        const value = argv[++index]
        if (value === undefined || value.startsWith('--')) {
          throw new CliError('--report needs a file path')
        }
        reportPath = value
        break
      }
      default:
        throw new CliError(`unknown argument: ${argument}`)
    }
  }

  return { command, write, mode, durationMs, sliceMs, faults, reportPath, quiet }
}

function readInt(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (value === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} needs a positive integer, got ${String(value)}`)
  }
  return parsed
}

export interface CliResult {
  readonly exitCode: number
  readonly output: string
}

/** Repository root, from `src/` or `dist/`. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

export async function runCli(argv: readonly string[]): Promise<CliResult> {
  let flags: CliFlags
  try {
    flags = parseFlags(argv)
  } catch (error) {
    return { exitCode: 2, output: `${(error as Error).message}\n\n${USAGE}` }
  }

  if (flags.command === 'help') return { exitCode: 0, output: USAGE }

  if (flags.command === 'matrix') {
    const document = renderFaultMatrixDoc()
    if (!flags.write) return { exitCode: 0, output: document }
    const target = join(REPO_ROOT, FAULT_MATRIX_DOC_PATH)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, document, 'utf8')
    return { exitCode: 0, output: `wrote ${FAULT_MATRIX_DOC_PATH}` }
  }

  const config = loadSoakConfig()
  const lines: string[] = []
  const report = await runSoak({
    mode: flags.mode,
    config,
    ...(flags.durationMs === null && flags.sliceMs === null
      ? {}
      : {
          shape: {
            ...(flags.durationMs === null ? {} : { durationMs: flags.durationMs }),
            ...(flags.sliceMs === null ? {} : { sliceMs: flags.sliceMs }),
          },
        }),
    ...(flags.faults ? {} : { faults: [] }),
    onLog: (line) => {
      if (!flags.quiet) lines.push(line)
    },
  })

  if (flags.reportPath !== null) {
    const target = resolve(REPO_ROOT, flags.reportPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    lines.push(`report written to ${flags.reportPath}`)
  }

  lines.push('', formatSoakReport(report))
  return { exitCode: report.passed ? 0 : 1, output: lines.join('\n') }
}
