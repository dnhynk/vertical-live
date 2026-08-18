import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, win32 as winPath } from 'node:path'

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
 *
 * `obs.process.executablePath` is a Windows path by contract (BOARD D-2), so it
 * is split with `path.win32` rather than with whatever the host platform is.
 * The default export is the running platform's implementation, and on POSIX a
 * backslash is an ordinary character: `dirname` of the shipped default answers
 * `'.'` there, which would launch OBS from the wrong working directory. Same
 * result on this Windows host, defined everywhere else.
 *
 * One thing it does besides spawning: it empties OBS's crash-sentinel directory
 * first (BOARD D-7). A sentinel file left by a crash makes the next start offer
 * Safe Mode, and Safe Mode disables obs-websocket — an unattended host would sit
 * on a modal dialog with the control path switched off. Both launch paths go
 * through here, so that is one place rather than two. The caveat is in
 * `docs/ops/windows-host.md` 5.7: this is **not** a documented OBS procedure,
 * and it hides the crash marker rather than the crash.
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
    const image = winPath.basename(executablePath)
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

/**
 * The two file operations the sentinel clearing needs, injected so the policy is
 * testable without a real `%APPDATA%`. Names rather than paths cross this
 * boundary: joining them is the implementation's business, and a Windows path
 * must not be assembled with the test host's separator (T17b).
 */
export interface ObsSentinelFs {
  /** File names directly inside `dir`. Throws `ENOENT` when `dir` is absent. */
  list(dir: string): readonly string[]
  /** Removes one entry of `dir` by name. */
  remove(dir: string, name: string): void
}

/** Files only: the directory itself stays, and so does anything nested in it. */
export const nodeObsSentinelFs: ObsSentinelFs = {
  list: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  remove: (dir, name) => {
    rmSync(join(dir, name))
  },
}

export interface ObsProcessLauncherOptions {
  readonly config: ObsProcessConfig
  readonly spawner?: ObsProcessSpawner
  readonly probe?: ObsProcessProbe
  readonly exists?: (path: string) => boolean
  readonly sentinel?: ObsSentinelFs
  readonly logger?: Logger
}

export interface ObsLaunchPlan {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

export interface ObsLaunchResult extends ObsLaunchPlan {
  readonly pid: number
  /**
   * Files removed from `obs.process.sentinelDir` immediately before the spawn
   * (BOARD D-7). Above zero means the previous OBS did not exit cleanly, so a
   * count that stays above zero launch after launch *is* the crash loop — the
   * clearing hides the dialog, not the fault (`docs/ops/windows-host.md` 5.7).
   */
  readonly sentinelCleared: number
  /**
   * Why the clearing did not finish (an EACCES on a file, an unreadable
   * directory), or null when nothing went wrong. A failure here never fails the
   * launch: OBS then behaves as it did before D-7 — the dialog appears, the
   * start-up step waits for a port that never opens and records the failure.
   */
  readonly sentinelFailure: string | null
}

export class ObsProcessLauncher {
  readonly #config: ObsProcessConfig
  readonly #spawner: ObsProcessSpawner
  readonly #probe: ObsProcessProbe
  readonly #exists: (path: string) => boolean
  readonly #sentinel: ObsSentinelFs
  readonly #logger: Logger

  constructor(options: ObsProcessLauncherOptions) {
    this.#config = options.config
    this.#spawner = options.spawner ?? nodeObsProcessSpawner
    this.#probe = options.probe ?? tasklistObsProcessProbe
    this.#exists = options.exists ?? ((path) => existsSync(path))
    this.#sentinel = options.sentinel ?? nodeObsSentinelFs
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
      cwd: winPath.dirname(this.#config.executablePath),
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
        `${winPath.basename(plan.command)} is already running; a second instance would not recover an unresponsive OBS (docs/ops/windows-host.md)`,
      )
    }

    // Last thing before the spawn, and only once every refusal above has passed:
    // there is no reason to touch OBS's files on a launch that is not happening.
    const sentinel = this.#clearSentinel()

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
    return {
      ...plan,
      pid: child.pid,
      sentinelCleared: sentinel.cleared,
      sentinelFailure: sentinel.failure,
    }
  }

  /**
   * Empties `obs.process.sentinelDir` (BOARD D-7). Never throws: every outcome
   * — nothing configured, no directory on disk, a file that will not go — still
   * launches OBS, because the fallback for a sentinel that survives is the
   * behaviour we had before D-7, not a host that refuses to start.
   *
   * The count is logged only when something was actually removed: an ordinary
   * start has nothing to say, while a run of non-zero counts is the evidence
   * that OBS keeps crashing behind the cleared marker.
   */
  #clearSentinel(): { readonly cleared: number; readonly failure: string | null } {
    const dir = this.#config.sentinelDir
    if (dir === '') return { cleared: 0, failure: null }

    let names: readonly string[]
    try {
      names = this.#sentinel.list(dir)
    } catch (error) {
      // No directory at all is the normal state of a host that has never
      // crashed, not a fault.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { cleared: 0, failure: null }
      }
      const failure = describeError(error)
      this.#logger.warn('obs.sentinel_clear_failed', { dir, cleared: 0, error: failure })
      return { cleared: 0, failure }
    }

    let cleared = 0
    let failure: string | null = null
    for (const name of names) {
      try {
        this.#sentinel.remove(dir, name)
        cleared += 1
      } catch (error) {
        // Keep going: one locked file must not leave the others behind.
        failure ??= describeError(error)
      }
    }
    if (failure !== null) {
      this.#logger.warn('obs.sentinel_clear_failed', { dir, cleared, error: failure })
    }
    if (cleared > 0) {
      this.#logger.info('obs.sentinel_cleared', { dir, cleared })
    }
    return { cleared, failure }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
