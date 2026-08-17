import { describe, expect, it } from 'vitest'

import { describeOpsConfig } from './ops-config.js'

/**
 * Review round 1, M1: the Windows launcher must see the same values the server
 * sees, env overrides included. These tests pin that the view comes from the
 * real loaders rather than from a second copy of the precedence rules.
 */

describe('describeOpsConfig', () => {
  it('describes the shipped defaults', () => {
    const view = describeOpsConfig({ env: {} })

    expect(view.server).toMatchObject({ host: '127.0.0.1', port: 8787 })
    expect(view.server.healthUrl).toBe('http://127.0.0.1:8787/health')
    expect(view.renderer).toMatchObject({ host: '127.0.0.1', port: 5173 })
    expect(view.renderer.url).toBe('http://127.0.0.1:5173/')
    expect(view.obs).toMatchObject({
      websocketUrl: 'ws://127.0.0.1:4455',
      websocketPort: 4455,
      processEnabled: false,
      executableName: 'obs64.exe',
    })
    expect(view.archive.enabled).toBe(true)
  })

  it('honours VL_OBS_PROCESS_ENABLED, which the raw config file cannot show', () => {
    // The reviewer's reproduction: with this set, the launcher used to keep
    // printing "obs.process.enabled is false".
    expect(describeOpsConfig({ env: { VL_OBS_PROCESS_ENABLED: 'true' } }).obs.processEnabled).toBe(
      true,
    )
  })

  it('honours the renderer and server port overrides', () => {
    const view = describeOpsConfig({
      env: {
        VL_RENDERER_STATIC_PORT: '5999',
        VL_RENDERER_STATIC_HOST: 'localhost',
        VL_PORT: '18787',
      },
    })

    expect(view.renderer).toMatchObject({ host: 'localhost', port: 5999 })
    expect(view.renderer.url).toBe('http://localhost:5999/')
    expect(view.server.port).toBe(18787)
    expect(view.server.healthUrl).toBe('http://127.0.0.1:18787/health')
  })

  it('honours VL_OBS_URL for the readiness port', () => {
    const view = describeOpsConfig({ env: { VL_OBS_URL: 'ws://127.0.0.1:4499' } })

    expect(view.obs).toMatchObject({ websocketUrl: 'ws://127.0.0.1:4499', websocketPort: 4499 })
  })

  it('honours VL_OBS_EXECUTABLE and reports the name the port owner should have', () => {
    const view = describeOpsConfig({ env: { VL_OBS_EXECUTABLE: 'D:\\obs\\bin\\obs64.exe' } })

    expect(view.obs.executablePath).toBe('D:\\obs\\bin\\obs64.exe')
    expect(view.obs.executableName).toBe('obs64.exe')
  })

  it('names the repository the config was read from', () => {
    const view = describeOpsConfig({ env: {} })

    expect(view.repoRoot).toMatch(/[\\/][^\\/]+$/)
    expect(view.renderer.directory.startsWith(view.repoRoot)).toBe(true)
  })

  it('refuses a non-loopback override instead of describing it (spec §10.2)', () => {
    expect(() => describeOpsConfig({ env: { VL_OBS_URL: 'ws://10.0.0.5:4455' } })).toThrow()
    expect(() => describeOpsConfig({ env: { VL_RENDERER_STATIC_HOST: '0.0.0.0' } })).toThrow()
  })
})
