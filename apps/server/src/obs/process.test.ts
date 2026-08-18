import { describe, expect, it, vi } from 'vitest'

import { loadObsConfig, type ObsProcessConfig } from './config.js'
import {
  ObsProcessError,
  ObsProcessLauncher,
  type ObsProcessProbe,
  type ObsProcessSpawner,
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

  it('takes env overrides for the host-specific values', () => {
    const config = loadObsConfig({
      env: { VL_OBS_PROCESS_ENABLED: 'true', VL_OBS_EXECUTABLE: 'D:\\obs\\obs64.exe' },
    })

    expect(config.process).toMatchObject({ enabled: true, executablePath: 'D:\\obs\\obs64.exe' })
  })
})
