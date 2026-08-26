import type { Clock } from '../../clock.js'
import type { Logger } from '../../secrets/redaction.js'
import { DEFAULT_ARCHIVE_CWD, loadArchiveConfig, type ArchiveConfig } from './config.js'
import { runArchiveSweep, type ArchiveFsPort, type ArchiveSweepResult } from './sweep.js'

/**
 * `archive` CLI — the rolling archive's operator entry point (spec §9.1, §11).
 *
 * Dry run is what you get by default; `--apply` is the only way to delete. The
 * scheduled task registered by `ops/windows/Register-VerticalLive.ps1` passes
 * `--apply`, and an operator checking what *would* happen does not have to
 * remember a safety flag (TASK_SPECS §T17 합격 기준 1).
 */

export interface ArchiveCliIo {
  write(line: string): void
}

export interface ArchiveCliDeps {
  readonly io: ArchiveCliIo
  /** Injected in tests; otherwise `config/default.json` is read. */
  readonly config?: ArchiveConfig
  readonly fs?: ArchiveFsPort
  readonly clock?: Clock
  readonly logger?: Logger
  readonly cwd?: string
}

const USAGE = `usage:
  archive [--apply] [--json] [--config <path>]

Default is a DRY RUN: the plan is printed and nothing is deleted.
--apply   delete the planned files
--json    machine-readable report on stdout
--config  read a different config file instead of config/default.json`

export function runArchiveCli(argv: readonly string[], deps: ArchiveCliDeps): number {
  const args = parseArgs(argv)
  if ('error' in args) {
    deps.io.write(`${args.error}\n${USAGE}`)
    return 1
  }
  if (args.help) {
    deps.io.write(USAGE)
    return 0
  }

  let config: ArchiveConfig
  try {
    config =
      deps.config ??
      loadArchiveConfig(args.configPath === undefined ? {} : { configPath: args.configPath })
  } catch (error) {
    deps.io.write(error instanceof Error ? error.message : String(error))
    return 1
  }

  if (!config.enabled) {
    deps.io.write('archive.enabled is false: nothing was scanned or deleted')
    return 0
  }

  const result = runArchiveSweep({
    config,
    apply: args.apply,
    ...(deps.fs === undefined ? {} : { fs: deps.fs }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    // npm workspaces run package scripts from the workspace directory. Archive
    // roots belong to the repository config, so caller cwd must not redirect a
    // production sweep to apps/server/data. Tests can still inject an isolated
    // base explicitly.
    cwd: deps.cwd ?? DEFAULT_ARCHIVE_CWD,
  })

  if (args.json) {
    deps.io.write(JSON.stringify(result))
  } else {
    for (const line of report(result, config)) deps.io.write(line)
  }

  // A failed delete and a refused root are both the operator's problem to look
  // at — the second means the archive is not being enforced where they pointed
  // it — so both are exit codes. An unmet rule is not, because the sweeper did
  // everything it could.
  const refused = result.roots.filter((root) => root.refused !== null)
  return result.failed.length > 0 || refused.length > 0 ? 1 : 0
}

function report(result: ArchiveSweepResult, config: ArchiveConfig): string[] {
  const lines: string[] = [
    `archive sweep ${result.at} (${result.applied ? 'APPLY' : 'dry run — nothing deleted'})`,
    `rules: retention ${String(config.retentionDays)}d · max total ${mib(config.maxTotalBytes)} · min free ${mib(config.minFreeBytes)} (all provisional, BOARD A-15)`,
  ]

  for (const root of result.roots) {
    if (!root.exists) {
      lines.push(`root ${root.name}: (missing) ${root.path}`)
      continue
    }
    if (root.refused !== null) {
      // A refused root is louder than a missing one: the operator configured a
      // path this sweeper will not delete from (review round 1, B1).
      lines.push(`root ${root.name}: REFUSED (${root.refused}) ${root.path}`)
      continue
    }
    lines.push(
      `root ${root.name}: ${String(root.files)} file(s), ${mib(root.bytes)} — ${root.path}`,
    )
  }

  lines.push(
    `scanned ${String(result.plan.scannedFiles)} file(s), ${mib(result.plan.scannedBytes)}; ${String(result.plan.protectedFiles)} inside the write grace window; free ${result.freeBytes === null ? 'unknown' : mib(result.freeBytes)}`,
  )

  if (result.plan.deletions.length === 0) {
    lines.push('no files selected for deletion')
  } else {
    lines.push(
      `${result.applied ? 'deleted' : 'would delete'} ${String(result.plan.deletions.length)} file(s), ${mib(result.plan.reclaimBytes)}:`,
    )
    for (const deletion of result.plan.deletions) {
      lines.push(`  [${deletion.reason}] ${mib(deletion.file.sizeBytes)}  ${deletion.file.path}`)
    }
  }

  for (const failure of result.failed) {
    lines.push(`  FAILED ${failure.path}: ${failure.error}`)
  }
  for (const rule of result.plan.unmetRules) {
    lines.push(`WARNING: ${rule} is still unmet after this sweep`)
  }

  return lines
}

function mib(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`
}

interface ParsedArgs {
  readonly apply: boolean
  readonly json: boolean
  readonly help: boolean
  readonly configPath?: string
}

function parseArgs(argv: readonly string[]): ParsedArgs | { readonly error: string } {
  let apply = false
  let json = false
  let help = false
  let configPath: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--apply':
        apply = true
        break
      case '--json':
        json = true
        break
      case '--dry-run':
        apply = false
        break
      case '--help':
      case '-h':
        help = true
        break
      case '--config': {
        const value = argv[index + 1]
        if (value === undefined) return { error: 'missing value for --config' }
        configPath = value
        index += 1
        break
      }
      default:
        return { error: `unknown argument: ${String(arg)}` }
    }
  }

  return { apply, json, help, ...(configPath === undefined ? {} : { configPath }) }
}
