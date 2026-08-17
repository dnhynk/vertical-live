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
    process.stdout.write(`obs launched: pid ${String(result.pid)}\n`)
  } catch (error) {
    const reason = error instanceof ObsProcessError ? error.reason : 'error'
    process.stderr.write(`obs launch refused (${reason}): ${(error as Error).message}\n`)
    process.exitCode = 1
  }
}
