import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadObsConfig, type ObsProcessConfig } from './config.js'
import {
  nodeObsSentinelFs,
  ObsProcessError,
  ObsProcessLauncher,
  type ObsProcessLauncherOptions,
  type ObsProcessProbe,
  type ObsProcessSpawner,
  type ObsSentinelFs,
} from './process.js'

/**
 * The `obs-process` launcher T12 left for T17 (`docs/ops/supervisor.md` 3장).
 * Its contract is mostly refusals: a launcher that reports a success it did not
 * achieve keeps the supervisor in a recovery that cannot recover (spec §9.2).
 */

const config: ObsProcessConfig = {
  enabled: true,
  executablePath: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
  profile: 'vertical-live',
  sceneCollection: 'vertical-live',
  extraArgs: ['--disable-updater'],
  sentinelDir: 'C:\\Users\\test\\AppData\\Roaming\\obs-studio\\.sentinel',
}

/** Nothing to clear, and nothing that can be blamed for a failure. */
const emptySentinel: ObsSentinelFs = {
  isReparsePoint: () => false,
  realPath: (dir) => dir,
  // The fake canonicalises to itself, so "the root is still the entry its own
  // parent holds" is exactly "the root came back unchanged".
  matchesParentEntry: (dir, root) => root === dir,
  list: () => [],
  canonicalFile: (root, name) => `${root}\\${name}`,
  remove: () => {},
}

function spawner(pid = 4242): ObsProcessSpawner & { readonly calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    spawn: (command, args, cwd) => {
      calls.push({ command, args: [...args], cwd })
      return { pid, unref: () => {} }
    },
  }
}

const notRunning: ObsProcessProbe = { running: () => false }

describe('ObsProcessLauncher', () => {
  it('launches with the documented profile and collection parameters', () => {
    const spawns = spawner()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: emptySentinel,
    })

    const result = launcher.launch()

    expect(result.pid).toBe(4242)
    expect(spawns.calls).toEqual([
      {
        command: config.executablePath,
        args: ['--profile', 'vertical-live', '--collection', 'vertical-live', '--disable-updater'],
        // Literal, not `dirname(config.executablePath)`: computing the
        // expectation with the function under test made this assertion pass on
        // a POSIX runner with both sides equal to `'.'` (T17b).
        cwd: 'C:\\Program Files\\obs-studio\\bin\\64bit',
      },
    ])
  })

  it('never puts a secret on the command line (spec §10.2)', () => {
    const launcher = new ObsProcessLauncher({ config, probe: notRunning, exists: () => true })

    const plan = launcher.plan()

    expect(plan.args.join(' ')).not.toMatch(/password|token|key/i)
  })

  it('runs OBS from its own directory so it finds its data', () => {
    const launcher = new ObsProcessLauncher({ config, probe: notRunning, exists: () => true })

    expect(launcher.plan().cwd).toBe('C:\\Program Files\\obs-studio\\bin\\64bit')
  })

  it('refuses when the launcher is not configured', () => {
    const spawns = spawner()
    const launcher = new ObsProcessLauncher({
      config: { ...config, enabled: false },
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
    })

    expect(() => launcher.launch()).toThrow(ObsProcessError)
    expect(spawns.calls).toEqual([])
  })

  it('refuses when the executable is not where the config says', () => {
    const spawns = spawner()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => false,
    })

    expect(() => launcher.launch()).toThrow(/obs executable not found/)
    expect(spawns.calls).toEqual([])
  })

  it('refuses to start a second instance when OBS is already running', () => {
    const spawns = spawner()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: { running: () => true },
      exists: () => true,
    })

    let reason = ''
    try {
      launcher.launch()
    } catch (error) {
      reason = (error as ObsProcessError).reason
    }

    expect(reason).toBe('already_running')
    expect(spawns.calls).toEqual([])
  })

  it('fails when the spawn produced no pid', () => {
    const launcher = new ObsProcessLauncher({
      config,
      spawner: { spawn: () => ({ pid: undefined, unref: () => {} }) },
      probe: notRunning,
      exists: () => true,
      sentinel: emptySentinel,
    })

    expect(() => launcher.launch()).toThrow(/no pid/)
  })

  it('logs the launch without leaking the environment', () => {
    const info = vi.fn()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawner(),
      probe: notRunning,
      exists: () => true,
      sentinel: emptySentinel,
      logger: { debug: () => {}, info, warn: () => {}, error: () => {} },
    })

    launcher.launch()

    expect(info).toHaveBeenCalledWith('obs process launched', {
      pid: 4242,
      profile: 'vertical-live',
      collection: 'vertical-live',
    })
  })
})

describe('crash sentinel clearing (BOARD D-7)', () => {
  /**
   * OBS leaves a file in `.sentinel` when it dies, and finding one at the next
   * start is what makes it offer Safe Mode — which disables obs-websocket, i.e.
   * every control path we have. Clearing it is **not** a documented OBS
   * procedure (`docs/ops/windows-host.md` 5.7); what the tests pin is that it
   * happens in the one place both launch paths go through, that it never turns
   * into a reason not to start OBS, and that the count is reported rather than
   * swallowed.
   */

  function sentinelFs(names: readonly string[], failOn?: string, escaped?: string) {
    const removed: string[] = []
    const listed: string[] = []
    const checked: string[] = []
    const fs: ObsSentinelFs = {
      isReparsePoint: () => false,
      // The fixture directory is a Windows path, so the fake canonicalises to
      // itself and joins with a backslash wherever this runs (T17b).
      realPath: (dir) => dir,
      // Same answer the real one gives: the root that came back is the entry
      // this directory's own parent holds under that name.
      matchesParentEntry: (dir, root) => root === dir,
      list: (dir) => {
        listed.push(dir)
        return names
      },
      canonicalFile: (root, name) => {
        checked.push(`${root}|${name}`)
        return name === escaped ? null : `${root}\\${name}`
      },
      remove: (path) => {
        if (failOn !== undefined && path.endsWith(`\\${failOn}`)) {
          throw Object.assign(new Error(`EACCES: permission denied, unlink '${failOn}'`), {
            code: 'EACCES',
          })
        }
        removed.push(path)
      },
    }
    return { fs, removed, listed, checked }
  }

  it('removes the sentinel files and reports how many, before the spawn', () => {
    const order: string[] = []
    const sentinel = sentinelFs(['run_1234', 'run_5678'])
    const info = vi.fn()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: {
        spawn: (command, args, cwd) => {
          order.push('spawn')
          void command
          void args
          void cwd
          return { pid: 77, unref: () => {} }
        },
      },
      probe: notRunning,
      exists: () => true,
      sentinel: {
        ...sentinel.fs,
        remove: (path) => {
          order.push('remove')
          sentinel.fs.remove(path)
        },
      },
      logger: { debug: () => {}, info, warn: () => {}, error: () => {} },
    })

    const result = launcher.launch()

    expect(result.sentinelCleared).toBe(2)
    expect(result.sentinelFailure).toBeNull()
    expect(sentinel.removed).toEqual([
      `${config.sentinelDir}\\run_1234`,
      `${config.sentinelDir}\\run_5678`,
    ])
    // The dialog is decided when OBS starts, so the clearing has to be finished
    // by then — not merely attempted at some point during the launch.
    expect(order).toEqual(['remove', 'remove', 'spawn'])
    expect(info).toHaveBeenCalledWith('obs.sentinel_cleared', {
      dir: config.sentinelDir,
      cleared: 2,
    })
  })

  it('treats a missing sentinel directory as nothing to clear', () => {
    const spawns = spawner()
    const info = vi.fn()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: {
        isReparsePoint: () => false,
        realPath: (dir) => dir,
        matchesParentEntry: (dir, root) => root === dir,
        list: () => {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        },
        canonicalFile: () => null,
        remove: () => {
          throw new Error('unreachable')
        },
      },
      logger: { debug: () => {}, info, warn: () => {}, error: () => {} },
    })

    const result = launcher.launch()

    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBeNull()
    expect(spawns.calls).toHaveLength(1)
    expect(info).not.toHaveBeenCalledWith('obs.sentinel_cleared', expect.anything())
  })

  it('treats a sentinel directory that will not resolve as nothing to clear', () => {
    // Same outcome from the other end of the same `try`: the canonical root is
    // taken before the listing (review round 2, B1), so on a host that never
    // crashed it is `realPath` and not `list` that reports the absence.
    const spawns = spawner()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: {
        isReparsePoint: () => false,
        realPath: () => {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        },
        matchesParentEntry: () => {
          throw new Error('unreachable')
        },
        list: () => {
          throw new Error('unreachable')
        },
        canonicalFile: () => null,
        remove: () => {
          throw new Error('unreachable')
        },
      },
    })

    const result = launcher.launch()

    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBeNull()
    expect(spawns.calls).toHaveLength(1)
  })

  it('starts OBS anyway when a file will not go, and says which ones did', () => {
    const spawns = spawner()
    const warn = vi.fn()
    const sentinel = sentinelFs(['run_locked', 'run_free'], 'run_locked')
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: sentinel.fs,
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    })

    const result = launcher.launch()

    // Refusing to launch here would be worse than the dialog: without D-7 the
    // host behaved exactly like this and the start-up step recorded the failure
    // when the websocket port never opened.
    expect(result.pid).toBe(4242)
    expect(spawns.calls).toHaveLength(1)
    expect(result.sentinelCleared).toBe(1)
    // The code, not the message. Node's message for this failure is
    // `EACCES: permission denied, unlink 'run_locked'` — the fake above raises
    // exactly that — and this value is logged and copied into `/health`
    // (`main.ts`), so the file name must not travel with it (review round 1, m1).
    expect(result.sentinelFailure).toBe('EACCES')
    expect(result.sentinelFailure).not.toContain('run_locked')
    expect(sentinel.removed).toEqual([`${config.sentinelDir}\\run_free`])
    expect(warn).toHaveBeenCalledWith('obs.sentinel_clear_failed', {
      dir: config.sentinelDir,
      cleared: 1,
      error: 'EACCES',
    })
  })

  it('reports an error that carries no code as `unknown` rather than as its text', () => {
    const spawns = spawner()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: {
        isReparsePoint: () => false,
        realPath: (dir) => dir,
        matchesParentEntry: (dir, root) => root === dir,
        list: () => ['run_1234'],
        canonicalFile: (root, name) => `${root}\\${name}`,
        remove: () => {
          throw new Error("cannot remove 'run_1234'")
        },
      },
    })

    const result = launcher.launch()

    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBe('unknown')
    expect(spawns.calls).toHaveLength(1)
  })

  it('starts OBS anyway when the directory itself cannot be read', () => {
    const spawns = spawner()
    const warn = vi.fn()
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: {
        isReparsePoint: () => false,
        realPath: (dir) => dir,
        matchesParentEntry: (dir, root) => root === dir,
        list: () => {
          throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
        },
        canonicalFile: () => null,
        remove: () => {},
      },
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    })

    const result = launcher.launch()

    expect(result.pid).toBe(4242)
    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBe('EACCES')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('refuses a sentinel directory that is a reparse point, without reading it', () => {
    const spawns = spawner()
    const warn = vi.fn()
    const sentinel = sentinelFs(['not-a-sentinel.txt'])
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: { ...sentinel.fs, isReparsePoint: () => true },
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    })

    const result = launcher.launch()

    // Nothing is listed and nothing is removed: what a junction points at is
    // not the directory the operator approved in config, so its contents are
    // not this launcher's to delete (review round 1, B1).
    expect(sentinel.listed).toEqual([])
    expect(sentinel.removed).toEqual([])
    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBe('sentinel_dir_reparse_point')
    expect(warn).toHaveBeenCalledWith('obs.sentinel_clear_failed', {
      dir: config.sentinelDir,
      cleared: 0,
      error: 'sentinel_dir_reparse_point',
    })
    // Still a launch: a refusal to clear is never a refusal to start OBS.
    expect(result.pid).toBe(4242)
    expect(spawns.calls).toHaveLength(1)
  })

  it('refuses a root that stopped being the entry its own parent holds', () => {
    const spawns = spawner()
    const warn = vi.fn()
    const sentinel = sentinelFs(['not-a-sentinel.txt'])
    // Review round 3: the reparse check and the `realpath` that approves the
    // root are two lookups of the same path. Drop a junction between them and
    // the check answers "not a link" about the real directory while `realpath`
    // answers with the link's target — which then passes every containment test
    // as the approved root. Only `realPath` is overridden here; the predicate
    // that catches it is the fake's honest one.
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: { ...sentinel.fs, realPath: () => 'C:\\Users\\test\\outside' },
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    })

    const result = launcher.launch()

    // The outside directory is never listed, so nothing in it is ever a
    // candidate — the refusal lands before anything is read.
    expect(sentinel.listed).toEqual([])
    expect(sentinel.checked).toEqual([])
    expect(sentinel.removed).toEqual([])
    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBe('sentinel_dir_mismatch')
    expect(warn).toHaveBeenCalledWith('obs.sentinel_clear_failed', {
      dir: config.sentinelDir,
      cleared: 0,
      error: 'sentinel_dir_mismatch',
    })
    expect(spawns.calls).toHaveLength(1)
  })

  it('refuses a root that became a reparse point after it was resolved', () => {
    const spawns = spawner()
    const warn = vi.fn()
    const sentinel = sentinelFs(['run_1234'])
    // The cheap second half of the round 3 guard: the lexical path is asked
    // again after the root was resolved. A swap that leaves a link behind is
    // caught here even where the parent cross-check cannot see it.
    let checks = 0
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: {
        ...sentinel.fs,
        isReparsePoint: () => {
          checks += 1
          return checks > 1
        },
      },
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    })

    const result = launcher.launch()

    expect(checks).toBe(2)
    expect(sentinel.listed).toEqual([])
    expect(sentinel.removed).toEqual([])
    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBe('sentinel_dir_reparse_point')
    expect(spawns.calls).toHaveLength(1)
  })

  it('re-checks containment immediately before each removal and skips what escaped', () => {
    const spawns = spawner()
    const warn = vi.fn()
    // `escaped` stands for the entry that was a plain file in the listing and a
    // link by the time it was its turn — the window `list()` cannot close.
    const sentinel = sentinelFs(['run_1234', 'swapped', 'run_5678'], undefined, 'swapped')
    const launcher = new ObsProcessLauncher({
      config,
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: sentinel.fs,
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    })

    const result = launcher.launch()

    expect(sentinel.checked).toEqual([
      `${config.sentinelDir}|run_1234`,
      `${config.sentinelDir}|swapped`,
      `${config.sentinelDir}|run_5678`,
    ])
    expect(sentinel.removed).toEqual([
      `${config.sentinelDir}\\run_1234`,
      `${config.sentinelDir}\\run_5678`,
    ])
    expect(result.sentinelCleared).toBe(2)
    expect(result.sentinelFailure).toBe('sentinel_entry_escaped_dir')
    expect(warn).toHaveBeenCalledWith('obs.sentinel_clear_failed', {
      dir: config.sentinelDir,
      cleared: 2,
      error: 'sentinel_entry_escaped_dir',
    })
    expect(spawns.calls).toHaveLength(1)
  })

  it('does nothing when the host has no sentinel directory', () => {
    const sentinel = sentinelFs(['run_1234'])
    const launcher = new ObsProcessLauncher({
      config: { ...config, sentinelDir: '' },
      spawner: spawner(),
      probe: notRunning,
      exists: () => true,
      sentinel: sentinel.fs,
    })

    const result = launcher.launch()

    expect(result.sentinelCleared).toBe(0)
    expect(sentinel.listed).toEqual([])
  })

  it('leaves the sentinel alone on every refusal, and in a dry run', () => {
    const sentinel = sentinelFs(['run_1234'])
    const of = (overrides: Partial<ObsProcessLauncherOptions>) =>
      new ObsProcessLauncher({
        config,
        spawner: spawner(),
        probe: notRunning,
        exists: () => true,
        sentinel: sentinel.fs,
        ...overrides,
      })

    // `plan()` is what `obs:launch --dry-run` prints; a dry run that deleted
    // files would not be one.
    expect(of({}).plan().args).toContain('--profile')
    expect(() => of({ config: { ...config, enabled: false } }).launch()).toThrow(ObsProcessError)
    expect(() => of({ exists: () => false }).launch()).toThrow(ObsProcessError)
    expect(() => of({ probe: { running: () => true } }).launch()).toThrow(ObsProcessError)

    expect(sentinel.listed).toEqual([])
    expect(sentinel.removed).toEqual([])
  })
})

/**
 * Review round 1, B1 — against the real filesystem rather than a fake, because
 * the fault was in `nodeObsSentinelFs` and not in the policy above it: the
 * reviewer pointed `obs.process.sentinelDir` at a junction and the launcher
 * deleted the file in the junction's target, outside the approved directory.
 *
 * `junction` is the only link type Windows creates without elevation or
 * developer mode; on POSIX the type argument is ignored (Node docs). A file
 * symlink is attempted where the host allows one and skipped where it does not,
 * so the same file runs on both.
 */
describe('nodeObsSentinelFs against real links (review round 1, B1)', () => {
  const base = join(tmpdir(), `vl-obs-sentinel-${String(process.pid)}`)
  const outside = join(base, 'outside')
  const outsideFile = join(outside, 'not-a-sentinel.txt')
  const sentinelDir = join(base, '.sentinel')

  function launcherFor(dir: string, spawns: ObsProcessSpawner) {
    return new ObsProcessLauncher({
      config: { ...config, sentinelDir: dir },
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: nodeObsSentinelFs,
    })
  }

  /** True when this host let us make one; Windows needs elevation for it. */
  function trySymlinkFile(target: string, path: string): boolean {
    try {
      symlinkSync(target, path, 'file')
      return true
    } catch {
      return false
    }
  }

  beforeEach(() => {
    mkdirSync(outside, { recursive: true })
    writeFileSync(outsideFile, 'outside')
  })

  afterEach(() => {
    // `rm -rf` semantics: links are unlinked, not followed.
    rmSync(base, { recursive: true, force: true })
  })

  it('reports a real junction as a reparse point and a real directory as not', () => {
    mkdirSync(sentinelDir, { recursive: true })
    const link = join(base, '.sentinel-link')
    symlinkSync(outside, link, 'junction')

    expect(nodeObsSentinelFs.isReparsePoint(link)).toBe(true)
    expect(nodeObsSentinelFs.isReparsePoint(sentinelDir)).toBe(false)
    // Absent is not a refusal: `list()`'s ENOENT is what decides that case, and
    // a host that has never crashed has no `.sentinel` at all.
    expect(nodeObsSentinelFs.isReparsePoint(join(base, 'never-existed'))).toBe(false)
  })

  it('refuses a sentinel directory that is a junction and deletes nothing outside it', () => {
    symlinkSync(outside, sentinelDir, 'junction')
    const spawns = spawner()

    const result = launcherFor(sentinelDir, spawns).launch()

    expect(existsSync(outsideFile)).toBe(true)
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside')
    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBe('sentinel_dir_reparse_point')
    expect(spawns.calls).toHaveLength(1)
  })

  it('clears the real files of a real directory and leaves links and nested directories', () => {
    mkdirSync(sentinelDir, { recursive: true })
    const marker = join(sentinelDir, 'run_1234')
    writeFileSync(marker, 'crashed')
    const nested = join(sentinelDir, 'nested')
    mkdirSync(nested)
    writeFileSync(join(nested, 'keep.txt'), 'keep')
    const junction = join(sentinelDir, 'junction-out')
    symlinkSync(outside, junction, 'junction')
    const fileLink = join(sentinelDir, 'run_link')
    const fileLinkMade = trySymlinkFile(outsideFile, fileLink)

    const spawns = spawner()
    const result = launcherFor(sentinelDir, spawns).launch()

    expect(existsSync(marker)).toBe(false)
    expect(result.sentinelCleared).toBe(1)
    expect(result.sentinelFailure).toBeNull()
    expect(existsSync(outsideFile)).toBe(true)
    expect(existsSync(join(nested, 'keep.txt'))).toBe(true)
    expect(existsSync(junction)).toBe(true)
    if (fileLinkMade) expect(existsSync(fileLink)).toBe(true)
    expect(spawns.calls).toHaveLength(1)
  })

  it('resolves a real file to a canonical path and refuses a link entry or an absent name', () => {
    mkdirSync(sentinelDir, { recursive: true })
    writeFileSync(join(sentinelDir, 'run_1234'), 'crashed')
    symlinkSync(outside, join(sentinelDir, 'junction-out'), 'junction')
    const fileLinkMade = trySymlinkFile(outsideFile, join(sentinelDir, 'run_link'))
    // The root the launcher pins before the listing, not the configured
    // spelling: on a host whose temp directory is itself a link the two differ.
    const root = nodeObsSentinelFs.realPath(sentinelDir)

    // What comes back is the path that gets deleted, so it has to be the one
    // that was checked (review round 2, B1).
    expect(nodeObsSentinelFs.canonicalFile(root, 'run_1234')).toBe(join(root, 'run_1234'))
    expect(nodeObsSentinelFs.canonicalFile(root, 'junction-out')).toBeNull()
    expect(nodeObsSentinelFs.canonicalFile(root, 'gone')).toBeNull()
    // A link whose target *is* a regular file is the case `lstat` catches and
    // `stat` would not: the name is inside, the bytes are not.
    if (fileLinkMade) {
      expect(nodeObsSentinelFs.canonicalFile(root, 'run_link')).toBeNull()
    }
  })

  it('checks a resolved root against its own parent, and allows a junctioned parent', () => {
    mkdirSync(sentinelDir, { recursive: true })
    const root = nodeObsSentinelFs.realPath(sentinelDir)

    expect(nodeObsSentinelFs.matchesParentEntry(sentinelDir, root)).toBe(true)
    // The root a junction dropped in `.sentinel`'s place would have resolved
    // to: the parent still holds `.sentinel`, and it is not that (round 3).
    expect(
      nodeObsSentinelFs.matchesParentEntry(sentinelDir, nodeObsSentinelFs.realPath(outside)),
    ).toBe(false)

    // A `.sentinel` reached *through* a junctioned parent is an ordinary
    // placement, not an attack, and must still be cleared: both sides resolve
    // the parent, so both land on the same real directory.
    const realParent = join(base, 'roaming')
    mkdirSync(join(realParent, '.sentinel'), { recursive: true })
    const linkedParent = join(base, 'roaming-link')
    symlinkSync(realParent, linkedParent, 'junction')
    const viaLink = join(linkedParent, '.sentinel')

    expect(nodeObsSentinelFs.matchesParentEntry(viaLink, nodeObsSentinelFs.realPath(viaLink))).toBe(
      true,
    )
  })
})

/**
 * Review round 2, B1 — the reviewer's own reproduction, kept as a test. The
 * round 1 fix re-checked each entry immediately before removing it, but it
 * asked the question against `realpath(dir)` *computed at that moment*: rename
 * the real `.sentinel` away after `list()` and drop a junction in its lexical
 * place, and both sides of the comparison resolve under the junction's target,
 * so the check passes and a file outside the approved directory is deleted
 * (`sentinelCleared: 1`, `outsideFileStillExists: false`).
 *
 * The launcher now pins the canonical root once, before the listing, and
 * resolves every candidate against that fixed value. The swap is injected
 * through the port — the operations underneath are the real ones — because the
 * timing is what is under test, not the filesystem.
 *
 * What this does **not** close: the moment between `realpath(entry)` and the
 * `unlink`. Node exposes no `openat`/`unlinkat`, so there is no way to delete
 * the directory entry a handle was checked through; a swap landing inside that
 * window still wins. Both halves the reviewer used — replacing the root, and
 * replacing an entry with a link — are refused, and that is what is claimed.
 */
describe('nodeObsSentinelFs when the root is swapped after the listing (review round 2, B1)', () => {
  const base = join(tmpdir(), `vl-obs-sentinel-swap-${String(process.pid)}`)
  const outside = join(base, 'outside')
  const sentinelDir = join(base, '.sentinel')
  const moved = join(base, '.sentinel-moved')
  // The same name on both sides: after the swap the listed entry's lexical path
  // lands on a real regular file outside the approved directory, which is
  // exactly what the round 1 check let through.
  const marker = join(sentinelDir, 'run_1234')
  const outsideFile = join(outside, 'run_1234')

  beforeEach(() => {
    mkdirSync(outside, { recursive: true })
    writeFileSync(outsideFile, 'outside')
    mkdirSync(sentinelDir, { recursive: true })
    writeFileSync(marker, 'crashed')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('deletes nothing when the approved root is replaced by a junction after the listing', () => {
    let swapped = false
    const swapping: ObsSentinelFs = {
      ...nodeObsSentinelFs,
      list: (dir) => {
        const names = nodeObsSentinelFs.list(dir)
        renameSync(sentinelDir, moved)
        symlinkSync(outside, sentinelDir, 'junction')
        swapped = true
        return names
      },
    }
    const spawns = spawner()

    const result = new ObsProcessLauncher({
      config: { ...config, sentinelDir },
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: swapping,
    }).launch()

    expect(swapped).toBe(true)
    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBe('sentinel_entry_escaped_dir')
    expect(existsSync(outsideFile)).toBe(true)
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside')
    // Nothing was deleted anywhere: the real marker is still where the rename
    // put it.
    expect(existsSync(join(moved, 'run_1234'))).toBe(true)
    // And a refusal to clear is still not a refusal to start OBS.
    expect(spawns.calls).toHaveLength(1)
  })
})

/**
 * Review round 3 — the reviewer's reproduction again, one step earlier. The
 * round 2 fix pinned the root before the listing, but the reparse-point check
 * and the `realpath` that pins it are two lookups of the same path: rename the
 * real `.sentinel` away *between* them and drop a junction in its lexical
 * place, and the check answers "not a link" about the directory that was there
 * while `realpath` answers with the junction's target. That target becomes the
 * approved root, every containment test below agrees with it, and a file
 * outside the configured directory is deleted (`sentinelCleared: 1`,
 * `outsideFileStillExists: false`).
 *
 * The launcher now cross-checks the resolved root against its own parent —
 * `realpath(dirname)` + the name — and asks the reparse question again on the
 * lexical path before using either. A root redirected elsewhere no longer
 * equals the entry its parent holds; a `.sentinel` reached through a junctioned
 * *parent* still does, because that side resolves the parent too.
 *
 * What this does **not** close, and what the docs must not claim it does: the
 * window itself. Every check names a path, and Node has no
 * `openat`/`unlinkat` to say "the entry I just checked" — so a swap landing
 * between one of these checks and its use still wins, as does replacing the
 * directory with a *real* one at the same path, which no link check can see.
 * `docs/ops/windows-host.md` 5.7 lists both halves.
 */
describe('nodeObsSentinelFs when the root is swapped before it is resolved (review round 3)', () => {
  const base = join(tmpdir(), `vl-obs-sentinel-root-${String(process.pid)}`)
  const outside = join(base, 'outside')
  const sentinelDir = join(base, '.sentinel')
  const moved = join(base, '.sentinel-moved')
  const marker = join(sentinelDir, 'run_1234')
  const outsideFile = join(outside, 'run_1234')

  beforeEach(() => {
    mkdirSync(outside, { recursive: true })
    writeFileSync(outsideFile, 'outside')
    mkdirSync(sentinelDir, { recursive: true })
    writeFileSync(marker, 'crashed')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('deletes nothing when a junction replaces the approved root before it is resolved', () => {
    let swapped = false
    const swapping: ObsSentinelFs = {
      ...nodeObsSentinelFs,
      isReparsePoint: (dir) => {
        // The real answer, about the real directory — and then the swap, so the
        // `realpath` that follows resolves the junction instead. Only the first
        // call swaps; the second is the launcher's re-check.
        const answer = nodeObsSentinelFs.isReparsePoint(dir)
        if (!swapped) {
          renameSync(sentinelDir, moved)
          symlinkSync(outside, sentinelDir, 'junction')
          swapped = true
        }
        return answer
      },
    }
    const spawns = spawner()

    const result = new ObsProcessLauncher({
      config: { ...config, sentinelDir },
      spawner: spawns,
      probe: notRunning,
      exists: () => true,
      sentinel: swapping,
    }).launch()

    expect(swapped).toBe(true)
    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toBe('sentinel_dir_mismatch')
    expect(existsSync(outsideFile)).toBe(true)
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside')
    expect(existsSync(join(moved, 'run_1234'))).toBe(true)
    expect(spawns.calls).toHaveLength(1)
  })
})

describe('obs.process configuration', () => {
  it('ships disabled, because the executable path is host-specific', () => {
    expect(loadObsConfig().process.enabled).toBe(false)
  })

  it('names the repository profile and scene collection', () => {
    const shipped = loadObsConfig().process

    expect(shipped.profile).toBe('vertical-live')
    expect(shipped.sceneCollection).toBe('vertical-live')
  })

  it('only carries launch parameters that OBS documents', () => {
    // https://obsproject.com/kb/launch-parameters (2026-08-17).
    // `--disable-shutdown-check` was removed in OBS 32.0.0 and must not appear.
    const documented = new Set([
      '--disable-updater',
      '--disable-missing-files-check',
      '--minimize-to-tray',
      '--multi',
      '--always-on-top',
      '--studio-mode',
      '--verbose',
      '--unfiltered_log',
    ])

    for (const arg of loadObsConfig().process.extraArgs) {
      expect(documented).toContain(arg)
    }
  })

  it('derives the sentinel directory from APPDATA, with Windows separators', () => {
    // APPDATA only exists on Windows, so the derived value is a Windows path
    // wherever this test runs (T17b: do not use the host's separator).
    const derived = loadObsConfig({ env: { APPDATA: 'C:\\Users\\vl\\AppData\\Roaming' } })

    expect(derived.process.sentinelDir).toBe(
      'C:\\Users\\vl\\AppData\\Roaming\\obs-studio\\.sentinel',
    )
  })

  it('has no sentinel directory on a host without APPDATA', () => {
    expect(loadObsConfig({ env: {} }).process.sentinelDir).toBe('')
  })

  it('takes an explicit sentinel directory for a portable OBS install', () => {
    const overridden = loadObsConfig({
      env: {
        APPDATA: 'C:\\Users\\vl\\AppData\\Roaming',
        VL_OBS_SENTINEL_DIR: 'D:\\obs\\.sentinel',
      },
    })

    expect(overridden.process.sentinelDir).toBe('D:\\obs\\.sentinel')
  })

  it('does not call the sentinel path provisional: it is observed, not tuned', () => {
    expect(loadObsConfig().provisional).not.toContain('process')
  })

  it('takes env overrides for the host-specific values', () => {
    const config = loadObsConfig({
      env: { VL_OBS_PROCESS_ENABLED: 'true', VL_OBS_EXECUTABLE: 'D:\\obs\\obs64.exe' },
    })

    expect(config.process).toMatchObject({ enabled: true, executablePath: 'D:\\obs\\obs64.exe' })
  })
})
