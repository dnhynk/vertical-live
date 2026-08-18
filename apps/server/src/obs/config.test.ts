import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { assertWebSocketUrl, loadObsConfig, ObsConfigError } from './config.js'

const workDir = mkdtempSync(join(tmpdir(), 'vl-obs-config-'))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeConfig(name: string, contents: unknown): string {
  const path = join(workDir, name)
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  return path
}

const validSection = {
  url: 'ws://127.0.0.1:4455',
  connectTimeoutMs: 5000,
  pollIntervalMs: 2000,
  commandVerifyTimeoutMs: 5000,
  commandVerifyIntervalMs: 250,
  browserSourceName: 'test-browser-source',
  browserSourceUrl: 'http://127.0.0.1:5173/?mode=broadcast',
  streamIngestUrl: 'rtmps://test-ingest.invalid:443/live2',
  reconnect: { initialDelayMs: 1000, maxDelayMs: 30_000, factor: 2 },
  thresholds: {
    congestionDegradedAt: 0.2,
    skippedFrameRatioDegradedAt: 0.01,
    stalledSamplesDegradedAt: 2,
  },
  // T17 added the OBS launcher block; like every other section it is required
  // rather than defaulted, so a host config cannot silently lose it.
  process: {
    enabled: false,
    executablePath: 'C:\\obs\\obs64.exe',
    profile: 'vertical-live',
    sceneCollection: 'vertical-live',
    extraArgs: [],
    // "" means "derive it from APPDATA" (BOARD D-7). The key itself is required
    // like every other one, so an upgraded host config cannot lose it silently.
    sentinelDir: '',
  },
  provisional: ['pollIntervalMs'],
}

describe('loadObsConfig', () => {
  it('reads the repository config/default.json that ships with the server', () => {
    const config = loadObsConfig({ env: {} })

    expect(config.url).toBe('ws://127.0.0.1:4455')
    expect(config.pollIntervalMs).toBeGreaterThan(0)
    expect(config.thresholds.congestionDegradedAt).toBeGreaterThan(0)
    // Review round 1 finding 2: the ingestion URL ships in config, the key does
    // not — it comes from the vault at runtime (spec §10.2).
    expect(config.streamIngestUrl).toBe('rtmps://a.rtmps.youtube.com:443/live2')
    expect(JSON.stringify(config)).not.toMatch(/"key"/)
    // BOARD A-15: numbers the spec does not fix are declared, not silently fixed.
    expect(config.provisional).toContain('pollIntervalMs')
    expect(config.provisional).toContain('thresholds')
  })

  it('lets VL_OBS_URL override the file', () => {
    const path = writeConfig('override.json', { obs: validSection })

    const config = loadObsConfig({ configPath: path, env: { VL_OBS_URL: 'ws://localhost:4499' } })

    expect(config.url).toBe('ws://localhost:4499')
  })

  it('freezes the loaded config', () => {
    const path = writeConfig('frozen.json', { obs: validSection })

    const config = loadObsConfig({ configPath: path, env: {} })

    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.reconnect)).toBe(true)
    expect(Object.isFrozen(config.thresholds)).toBe(true)
  })

  it('rejects a missing file', () => {
    expect(() => loadObsConfig({ configPath: join(workDir, 'absent.json'), env: {} })).toThrow(
      ObsConfigError,
    )
  })

  it('rejects a corrupt file', () => {
    const path = writeConfig('corrupt.json', '{ not json')

    expect(() => loadObsConfig({ configPath: path, env: {} })).toThrow(/cannot read/)
  })

  it('rejects a file with no obs section', () => {
    const path = writeConfig('empty.json', { other: {} })

    expect(() => loadObsConfig({ configPath: path, env: {} })).toThrow(/missing "obs" section/)
  })

  it('rejects a non-positive interval instead of defaulting it', () => {
    const path = writeConfig('bad-interval.json', {
      obs: { ...validSection, pollIntervalMs: 0 },
    })

    expect(() => loadObsConfig({ configPath: path, env: {} })).toThrow(
      /obs\.pollIntervalMs must be a positive integer/,
    )
  })

  it('rejects a non-object reconnect block', () => {
    const path = writeConfig('bad-reconnect.json', { obs: { ...validSection, reconnect: 3 } })

    expect(() => loadObsConfig({ configPath: path, env: {} })).toThrow(
      /obs\.reconnect must be an object/,
    )
  })

  it('rejects a non-loopback url from the file', () => {
    const path = writeConfig('remote.json', {
      obs: { ...validSection, url: 'ws://198.51.100.7:4455' },
    })

    expect(() => loadObsConfig({ configPath: path, env: {} })).toThrow(/loopback/)
  })

  it('rejects a non-loopback url from the env override', () => {
    const path = writeConfig('env-remote.json', { obs: validSection })

    expect(() =>
      loadObsConfig({ configPath: path, env: { VL_OBS_URL: 'ws://198.51.100.7:4455' } }),
    ).toThrow(/loopback/)
  })

  it('allows a non-loopback url only with the explicit opt-out', () => {
    const path = writeConfig('allowed-remote.json', {
      obs: { ...validSection, url: 'ws://198.51.100.7:4455' },
    })

    const config = loadObsConfig({ configPath: path, env: {}, allowNonLoopback: true })

    expect(config.url).toBe('ws://198.51.100.7:4455')
  })
})

describe('assertWebSocketUrl', () => {
  it('accepts every loopback spelling', () => {
    for (const url of ['ws://127.0.0.1:4455', 'ws://localhost:4455', 'ws://[::1]:4455']) {
      expect(() => assertWebSocketUrl(url, false)).not.toThrow()
    }
  })

  it('rejects a non-websocket scheme', () => {
    expect(() => assertWebSocketUrl('http://127.0.0.1:4455', false)).toThrow(/must be ws/)
  })

  it('rejects a string that is not a url', () => {
    expect(() => assertWebSocketUrl('127.0.0.1:4455', false)).toThrow(/is not a URL/)
  })
})
