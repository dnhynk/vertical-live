import { describe, expect, it, vi } from 'vitest'

import { loadObsConfig, type ObsProcessConfig } from './config.js'
import {
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
  list: () => [],
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

  function sentinelFs(names: readonly string[], failOn?: string) {
    const removed: string[] = []
    const listed: string[] = []
    const fs: ObsSentinelFs = {
      list: (dir) => {
        listed.push(dir)
        return names
      },
      remove: (dir, name) => {
        if (name === failOn) {
          throw Object.assign(new Error(`EACCES: permission denied, unlink '${name}'`), {
            code: 'EACCES',
          })
        }
        removed.push(`${dir}|${name}`)
      },
    }
    return { fs, removed, listed }
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
        list: (dir) => sentinel.fs.list(dir),
        remove: (dir, name) => {
          order.push('remove')
          sentinel.fs.remove(dir, name)
        },
      },
      logger: { debug: () => {}, info, warn: () => {}, error: () => {} },
    })

    const result = launcher.launch()

    expect(result.sentinelCleared).toBe(2)
    expect(result.sentinelFailure).toBeNull()
    expect(sentinel.removed).toEqual([
      `${config.sentinelDir}|run_1234`,
      `${config.sentinelDir}|run_5678`,
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
        list: () => {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        },
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
    expect(result.sentinelFailure).toMatch(/EACCES/)
    expect(sentinel.removed).toEqual([`${config.sentinelDir}|run_free`])
    expect(warn).toHaveBeenCalledWith('obs.sentinel_clear_failed', {
      dir: config.sentinelDir,
      cleared: 1,
      error: expect.stringContaining('EACCES') as unknown as string,
    })
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
        list: () => {
          throw Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
        },
        remove: () => {},
      },
      logger: { debug: () => {}, info: () => {}, warn, error: () => {} },
    })

    const result = launcher.launch()

    expect(result.pid).toBe(4242)
    expect(result.sentinelCleared).toBe(0)
    expect(result.sentinelFailure).toMatch(/EACCES/)
    expect(warn).toHaveBeenCalledTimes(1)
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
