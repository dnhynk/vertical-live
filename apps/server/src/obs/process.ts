import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, win32 as winPath } from 'node:path'

// The same containment predicate T17's archive sweeper decides deletions with:
// one definition of "this canonical path is inside that canonical directory".
import { isInside } from '../ops/archive/sweep.js'
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
 * through here, so that is one place rather than two. It aims its deletions at
 * the configured directory: a `.sentinel` that is a junction or a symlink is
 * refused outright (review round 1, B1), the canonical root is resolved **once**
 * before the listing and cross-checked against its own parent so a root
 * redirected between the two lookups is refused (review round 3), and every
 * entry is re-resolved against that fixed root and then deleted by the
 * canonical path that was checked (review round 2, B1). What that does *not*
 * amount to is a closed check→use window: Node has no `openat`/`unlinkat`, so
 * every check names a path that something else may still replace before it is
 * used. `docs/ops/windows-host.md` 5.7 lists what is and is not guaranteed,
 * along with the other caveat: this is **not** a documented OBS procedure, and
 * it hides the crash marker rather than the crash.
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
 * The file operations the sentinel clearing needs, injected so the policy is
 * testable without a real `%APPDATA%`. Only `realPath` hands a whole path back
 * across this boundary; a listing crosses as names, because joining them is the
 * implementation's business and a Windows path must not be assembled with the
 * test host's separator (T17b). The two questions beside `list`/`remove` are
 * what keeps the deletions inside the approved directory, so an injected port
 * answers them too rather than defaulting to "allowed".
 */
export interface ObsSentinelFs {
  /**
   * True when `dir` itself is a symlink or a Windows junction (both are reparse
   * points; libuv reports both through `lstat().isSymbolicLink()`), and also
   * true when the check cannot be answered. False when `dir` is simply absent —
   * that case belongs to `list()`'s `ENOENT`. Must not follow the link.
   */
  isReparsePoint(dir: string): boolean
  /**
   * The canonical path of `dir`. Resolved once, before the listing, and every
   * later decision is made against that value rather than against the
   * configured path — which another process can replace with a link at any
   * moment (review round 2, B1). Throws like `realpath(2)`, `ENOENT` included.
   */
  realPath(dir: string): string
  /**
   * True when `root` — the value `realPath(dir)` just answered — is still the
   * entry `dir` names inside `dir`'s **own** canonical parent, i.e. when it
   * equals `join(realPath(dirname(dir)), basename(dir))` under this host's path
   * comparison. False when the two differ, and false when the question cannot
   * be answered.
   *
   * This is what is left of the check→use window on the root itself: `lstat`
   * and `realpath` are two separate lookups, and a junction dropped on the
   * lexical path between them makes `realpath` answer with the link's target,
   * which then passes every containment test below as the approved root
   * (review round 3). Resolving the parent instead of the path itself is the
   * asymmetry that catches it — a redirected `.sentinel` no longer sits where
   * its parent says it does, while a normal directory reached through a
   * junctioned *parent* still does, because the parent is resolved too.
   */
  matchesParentEntry(dir: string, root: string): boolean
  /** File names directly inside `dir`. Throws `ENOENT` when `dir` is absent. */
  list(dir: string): readonly string[]
  /**
   * The canonical path of `name` when it is still a regular file directly
   * inside the already-canonical `root`, and `null` otherwise — including when
   * the answer cannot be decided. Asked immediately before each removal, so a
   * listing that was replaced by a link in the meantime is refused rather than
   * deleted, and what it returns is what the caller deletes (T17
   * `canonicalTarget`).
   */
  canonicalFile(root: string, name: string): string | null
  /** Removes one file by the canonical path `canonicalFile` returned. */
  remove(path: string): void
}

/** Files only: the directory itself stays, and so does anything nested in it. */
export const nodeObsSentinelFs: ObsSentinelFs = {
  isReparsePoint: (dir) => {
    try {
      return lstatSync(dir).isSymbolicLink()
    } catch (error) {
      // A directory that is not there is the ordinary state of a host that has
      // never crashed, and `list()` already answers that with `ENOENT`. Any
      // other unreadable result is a check that could not answer, and a check
      // that cannot answer is a refusal rather than a permission to delete
      // (T17 `nodeArchiveFs.isLink`).
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  },
  realPath: (dir) => realpathSync.native(dir),
  matchesParentEntry: (dir, root) => {
    try {
      const parent = dirname(dir)
      // A path whose parent is itself (`C:\`, `/`) has no entry to be checked
      // against, so it is refused rather than approved. It is also not a
      // sentinel directory.
      if (parent === dir) return false
      return samePath(join(realpathSync.native(parent), basename(dir)), root)
    } catch {
      // A parent that will not resolve is a question that cannot be answered,
      // and that is a refusal (`isReparsePoint`, T17 `nodeArchiveFs.isLink`).
      return false
    }
  },
  list: (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  canonicalFile: (root, name) => {
    const path = join(root, name)
    try {
      // `lstat` rather than `stat`: a symlink whose target is a regular file
      // must not pass as one. Then the entry is canonicalised and compared
      // against the **fixed** root, which is what catches a root that became a
      // link after the listing — resolving the root again here would follow it
      // instead, and that is exactly how the reviewer deleted an outside file
      // (review round 2, B1).
      if (!lstatSync(path).isFile()) return null
      const real = realpathSync.native(path)
      return isInside(root, real) ? real : null
    } catch {
      return null
    }
  },
  remove: (path) => {
    rmSync(path)
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
   * Why the clearing did not finish, or null when nothing went wrong. Always a
   * token, never a message: an `errno` code (`EACCES`), `unknown`, or one of
   * the two refusals below. Node's own message for a file operation carries the
   * path it failed on, and this string is logged and copied into `/health`
   * (`main.ts`), so the fault stays identifiable here and the file name does not
   * travel with it (review round 1, m1).
   *
   * A failure here never fails the launch: OBS then behaves as it did before
   * D-7 — the dialog appears, the start-up step waits for a port that never
   * opens and records the failure.
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

    // A `.sentinel` that is itself a junction or a symlink is refused before it
    // is even read. Following it would make "inside the sentinel directory"
    // mean "inside whatever that link points at today" — not the directory the
    // operator approved in config, and its entries are not OBS's crash markers.
    // The reviewer deleted a file outside the approved directory this way
    // (review round 1, B1); it is the same refusal T17's archive sweeper makes
    // for a configured root (`REFUSED (reparse_point)`).
    if (this.#sentinel.isReparsePoint(dir)) {
      return this.#sentinelRefused(dir, SENTINEL_DIR_REPARSE_POINT)
    }

    // The approved root, canonicalised **once** and before anything is listed.
    // Every decision below is made against this value: the configured path can
    // be renamed away and replaced by a junction while this loop runs, and
    // asking `realpath` again at deletion time answers with wherever that new
    // junction points — which is how the reviewer got a file outside the
    // approved directory deleted (review round 2, B1).
    let root: string
    try {
      root = this.#sentinel.realPath(dir)
    } catch (error) {
      return this.#sentinelReadFailed(dir, error)
    }

    // …but the check above and that `realpath` are two lookups of the same
    // path, and a junction installed between them makes `realpath` hand back
    // the link's target as the "approved" root — after which every containment
    // test below agrees, because it is measuring against the wrong root. The
    // reviewer deleted an outside file exactly there (review round 3). So the
    // root is cross-checked against its own parent before it is used, and the
    // reparse check is repeated on the lexical path: a `.sentinel` that was
    // redirected elsewhere no longer equals `parent/.sentinel`, while a real
    // directory reached through a junctioned parent still does. Neither closes
    // the window — nothing without `openat` can — they narrow it to a swap that
    // lands between these calls and their use (`docs/ops/windows-host.md` 5.7).
    if (!this.#sentinel.matchesParentEntry(dir, root)) {
      return this.#sentinelRefused(dir, SENTINEL_DIR_MISMATCH)
    }
    if (this.#sentinel.isReparsePoint(dir)) {
      return this.#sentinelRefused(dir, SENTINEL_DIR_REPARSE_POINT)
    }

    let names: readonly string[]
    try {
      names = this.#sentinel.list(root)
    } catch (error) {
      return this.#sentinelReadFailed(dir, error)
    }

    let cleared = 0
    let failure: string | null = null
    for (const name of names) {
      // Listing and removing are two moments, and an entry — or the directory
      // it was listed from — can be replaced by a link between them. So the
      // entry is resolved again here against the fixed root instead of being
      // trusted from the listing, and one that no longer resolves inside it is
      // reported rather than removed (review round 1 and 2, B1 — T17 guards its
      // deletions the same way).
      const path = this.#sentinel.canonicalFile(root, name)
      if (path === null) {
        failure ??= SENTINEL_ENTRY_ESCAPED
        continue
      }
      try {
        // The checked path, not `join(dir, name)`: rejoining the configured
        // root would walk through whatever it points at now.
        this.#sentinel.remove(path)
        cleared += 1
      } catch (error) {
        // Keep going: one locked file must not leave the others behind.
        failure ??= errorCode(error)
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

  /** A policy refusal: nothing was read, nothing was deleted, OBS still starts. */
  #sentinelRefused(
    dir: string,
    token: string,
  ): { readonly cleared: number; readonly failure: string } {
    this.#logger.warn('obs.sentinel_clear_failed', { dir, cleared: 0, error: token })
    return { cleared: 0, failure: token }
  }

  /** The directory could not be resolved or read. Absent is not a fault. */
  #sentinelReadFailed(
    dir: string,
    error: unknown,
  ): { readonly cleared: number; readonly failure: string | null } {
    // No directory at all is the normal state of a host that has never crashed.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cleared: 0, failure: null }
    }
    const failure = errorCode(error)
    this.#logger.warn('obs.sentinel_clear_failed', { dir, cleared: 0, error: failure })
    return { cleared: 0, failure }
  }
}

/**
 * Two spellings of one location, decided the way the running host decides it:
 * `path.relative` is case- and separator-insensitive on Windows and neither on
 * POSIX, which is the same primitive the containment predicate above is built
 * on (`isInside`) rather than a second, differently-normalising comparison.
 */
function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === ''
}

/** The configured sentinel directory is a junction or a symlink. */
const SENTINEL_DIR_REPARSE_POINT = 'sentinel_dir_reparse_point'
/** The canonical root is not the entry its own parent holds under that name. */
const SENTINEL_DIR_MISMATCH = 'sentinel_dir_mismatch'
/** A listed entry stopped resolving inside the sentinel directory. */
const SENTINEL_ENTRY_ESCAPED = 'sentinel_entry_escaped_dir'

/**
 * The failure token, never the message. `Error.message` from a file operation
 * contains the path it failed on (`EACCES: permission denied, unlink
 * 'run_1234'`), and this value reaches the log and `/health`, so only the code
 * crosses the boundary (review round 1, m1).
 */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'unknown'
}
