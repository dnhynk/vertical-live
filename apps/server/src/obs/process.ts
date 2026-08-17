import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { ObsProcessConfig } from './config.js'

/**
 * Starting OBS itself — the `obs-process` component T12 left for T17
 * (`docs/ops/supervisor.md` 3장: "OBS 실행기(**T17 주입 전에는 실패**)").
 *
 * The same launcher is used by the logon autostart
 * (`ops/windows/Start-VerticalLive.ps1` calls `npm run obs:launch`) and by the
 * supervisor when the `obs-connection` budget escalates, so there is one
 * definition of "how this host starts OBS" instead of two that can drift.
 *
 * Two refusals are deliberate, because a launcher that reports success it did
 * not achieve is worse than one that fails (spec §9.2 → `safe_stopped`):
 *
 * - **not configured** — `obs.process.enabled` is false, or the executable is
 *   not where the config says. This is the state a fresh clone is in.
 * - **already running** — OBS is up but unreachable. A second instance would
 *   only raise OBS's "already running" dialog on an unattended host, and this
 *   process does not kill the operator's OBS on its own. A hung OBS is an
 *   operator action (`docs/ops/windows-host.md`).
 *
 * Only launch parameters from https://obsproject.com/kb/launch-parameters are
 * passed (checked 2026-08-17). Notably **not** passed: the obs-websocket
 * password — it is a vault secret and a command line is readable by every
 * process on the host (spec §10.2).
 */

export class ObsProcessError extends Error {
  readonly reason: string

  constructor(reason: string, message: string) {
    super(message)
    this.name = 'ObsProcessError'
    this.reason = reason
  }
}

export interface SpawnedProcess {
  /** Absent when the spawn failed; the launcher treats that as a failure. */
  readonly pid?: number | undefined
  unref(): void
}

export interface ObsProcessSpawner {
  spawn(command: string, args: readonly string[], cwd: string): SpawnedProcess
}

/**
 * Detached, with no stdio: OBS outlives the launching shell (the logon task
 * exits once the sequence is done) and never fills a pipe nobody reads.
 */
export const nodeObsProcessSpawner: ObsProcessSpawner = {
  spawn: (command, args, cwd) =>
    spawn(command, [...args], { cwd, detached: true, stdio: 'ignore', windowsHide: false }),
}

export interface ObsProcessProbe {
  /** True when an OBS process with this executable name is already running. */
  running(executablePath: string): boolean
}

/** Windows-only check (BOARD D-2 fixes the first host); other platforms answer false. */
export const tasklistObsProcessProbe: ObsProcessProbe = {
  running: (executablePath) => {
    if (process.platform !== 'win32') return false
    const image = basename(executablePath)
    try {
      const output = execFileSync(
        'tasklist',
        ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'],
        { encoding: 'utf8' },
      )
      return output.toLowerCase().includes(image.toLowerCase())
    } catch {
      // A probe that cannot answer must not claim "not running": that would
      // start a second instance. Treat it as running and let the escalation
      // fail honestly.
      return true
    }
  },
}

export interface ObsProcessLauncherOptions {
  readonly config: ObsProcessConfig
  readonly spawner?: ObsProcessSpawner
  readonly probe?: ObsProcessProbe
  readonly exists?: (path: string) => boolean
  readonly logger?: Logger
}

export interface ObsLaunchPlan {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

export interface ObsLaunchResult extends ObsLaunchPlan {
  readonly pid: number
}

export class ObsProcessLauncher {
  readonly #config: ObsProcessConfig
  readonly #spawner: ObsProcessSpawner
  readonly #probe: ObsProcessProbe
  readonly #exists: (path: string) => boolean
  readonly #logger: Logger

  constructor(options: ObsProcessLauncherOptions) {
    this.#config = options.config
    this.#spawner = options.spawner ?? nodeObsProcessSpawner
    this.#probe = options.probe ?? tasklistObsProcessProbe
    this.#exists = options.exists ?? ((path) => existsSync(path))
    this.#logger = options.logger ?? silentLogger
  }

  /**
   * The exact command this host would run. Used by the launcher's dry run and
   * by the log line, so what is printed is what would be executed.
   *
   * `cwd` is OBS's own `bin/64bit` directory: OBS resolves its locale and data
   * relative to the working directory, so launching it from elsewhere starts a
   * broken instance.
   */
  plan(): ObsLaunchPlan {
    return {
      command: this.#config.executablePath,
      args: [
        '--profile',
        this.#config.profile,
        '--collection',
        this.#config.sceneCollection,
        ...this.#config.extraArgs,
      ],
      cwd: dirname(this.#config.executablePath),
    }
  }

  launch(): ObsLaunchResult {
    if (!this.#config.enabled) {
      throw new ObsProcessError(
        'not_configured',
        'obs process launch is not configured (obs.process.enabled is false)',
      )
    }
    const plan = this.plan()
    if (!this.#exists(plan.command)) {
      throw new ObsProcessError(
        'executable_not_found',
        `obs executable not found at ${plan.command} (set obs.process.executablePath or VL_OBS_EXECUTABLE)`,
      )
    }
    if (this.#probe.running(plan.command)) {
      throw new ObsProcessError(
        'already_running',
        `${basename(plan.command)} is already running; a second instance would not recover an unresponsive OBS (docs/ops/windows-host.md)`,
      )
    }

    const child = this.#spawner.spawn(plan.command, plan.args, plan.cwd)
    if (child.pid === undefined) {
      throw new ObsProcessError('spawn_failed', `spawning ${plan.command} produced no pid`)
    }
    child.unref()
    this.#logger.info('obs process launched', {
      pid: child.pid,
      profile: this.#config.profile,
      collection: this.#config.sceneCollection,
    })
    return { ...plan, pid: child.pid }
  }
}
