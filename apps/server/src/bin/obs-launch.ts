import { loadObsConfig } from '../obs/config.js'
import { ObsProcessLauncher, ObsProcessError } from '../obs/process.js'

/**
 * Entry point for `npm run obs:launch -w @vl/server -- [--dry-run]`.
 *
 * The logon autostart (`ops/windows/Start-VerticalLive.ps1`) calls this rather
 * than starting OBS itself, so the profile, the scene collection and the launch
 * parameters have one definition — the one the supervisor's `obs-process`
 * recovery also uses (TASK_SPECS §T17).
 */
const dryRun = process.argv.slice(2).includes('--dry-run')
const launcher = new ObsProcessLauncher({ config: loadObsConfig().process })
const plan = launcher.plan()

if (dryRun) {
  process.stdout.write(`${plan.command} ${plan.args.join(' ')}\n(cwd ${plan.cwd}, dry run)\n`)
} else {
  try {
    const result = launcher.launch()
    // The sentinel count lands in `data\ops\logs\autostart-*.log` through this
    // line: the autostart path has no structured logger, and BOARD D-7 asks for
    // the number to be recorded wherever OBS is started from.
    process.stdout.write(
      `obs launched: pid ${String(result.pid)} (crash sentinels cleared: ${String(result.sentinelCleared)})\n`,
    )
    if (result.sentinelFailure !== null) {
      // Also stdout, and for the same reason. `Start-VerticalLive.ps1` captures
      // this process's stdout and appends it to the autostart log; on stderr the
      // cause never reached the log of a hidden scheduled task, so
      // `docs/ops/windows-host.md` 7장 sent the operator to look for a line that
      // was not there (review round 1, M1). The launch itself succeeded, so the
      // exit code stays 0 — this is a caveat on it, not a failure of it. The
      // value is a token by contract (`ObsLaunchResult.sentinelFailure`), so no
      // path and no file name is written here.
      process.stdout.write(`obs sentinel clearing incomplete: ${result.sentinelFailure}\n`)
    }
  } catch (error) {
    const reason = error instanceof ObsProcessError ? error.reason : 'error'
    process.stderr.write(`obs launch refused (${reason}): ${(error as Error).message}\n`)
    process.exitCode = 1
  }
}
