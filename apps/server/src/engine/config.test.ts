import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_WORLD_TUNING, FRESHNESS_MINIMUMS } from '../world/content/tuning.js'
import { EngineConfigError, loadEngineConfig } from './config.js'

/**
 * Engine configuration.
 *
 * The pinning test is the important one: TASK_SPECS §T8 requires the world
 * tuning to be injected from `config/default.json`, and a config block that
 * drifted away from the content defaults would mean the file no longer says what
 * the world actually runs on. Rather than trusting review to catch that, the file
 * and `DEFAULT_WORLD_TUNING` are asserted equal.
 */

const REPO_CONFIG = fileURLToPath(new URL('../../../../config/default.json', import.meta.url))

describe('loadEngineConfig', () => {
  const directories: string[] = []

  afterEach(() => {
    while (directories.length > 0) {
      rmSync(directories.pop() as string, { recursive: true, force: true })
    }
  })

  function writeConfig(config: unknown): string {
    const directory = mkdtempSync(join(tmpdir(), 'vl-engine-config-'))
    directories.push(directory)
    const path = join(directory, 'default.json')
    writeFileSync(path, JSON.stringify(config), 'utf8')
    return path
  }

  function repoConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(REPO_CONFIG, 'utf8')) as Record<string, unknown>
  }

  it('reads the repository configuration', () => {
    const config = loadEngineConfig({ env: {} })

    expect(config.engine.worldSeed).not.toBe('')
    expect(config.engine.identityGateOpen).toBe(false)
    expect(config.simulator.enabled).toBe(false)
    expect(config.engine.provisional).toContain('degraded.eventValidityMs')
  })

  it('injects the world tuning the content module defines (TASK_SPECS §T8)', () => {
    const config = loadEngineConfig({ env: {} })

    expect(config.tuning).toEqual(DEFAULT_WORLD_TUNING)
    expect(config.tuning.provisional).toBe(true)
    expect(config.freshness).toEqual(FRESHNESS_MINIMUMS)
  })

  it('lets an operator override a single tuning value', () => {
    const base = repoConfig()
    const path = writeConfig({
      ...base,
      world: { tuning: { staging: { reactionMs: 1234 } }, freshness: {} },
    })

    const config = loadEngineConfig({ configPath: path, env: {} })

    expect(config.tuning.staging.reactionMs).toBe(1234)
    // Untouched siblings keep the content default.
    expect(config.tuning.staging.ambienceMs).toBe(DEFAULT_WORLD_TUNING.staging.ambienceMs)
    expect(config.tuning.mission).toEqual(DEFAULT_WORLD_TUNING.mission)
  })

  it('refuses a tuning key it does not know', () => {
    const base = repoConfig()
    const path = writeConfig({ ...base, world: { tuning: { staging: { reactionMS: 1 } } } })

    expect(() => loadEngineConfig({ configPath: path, env: {} })).toThrow(
      /is not a known tuning key/,
    )
  })

  it('refuses a tuning value of the wrong type', () => {
    const base = repoConfig()
    const path = writeConfig({ ...base, world: { tuning: { staging: { reactionMs: 'fast' } } } })

    expect(() => loadEngineConfig({ configPath: path, env: {} })).toThrow(EngineConfigError)
  })

  it('applies env overrides', () => {
    const config = loadEngineConfig({
      env: {
        VL_WORLD_SEED: 'seed_from_env',
        VL_ENGINE_TICK_MS: '40',
        VL_EVENT_VALIDITY_MS: '60000',
        VL_SIMULATOR_ENABLED: 'true',
      },
    })

    expect(config.engine.worldSeed).toBe('seed_from_env')
    expect(config.engine.tickIntervalMs).toBe(40)
    expect(config.engine.degraded.eventValidityMs).toBe(60_000)
    expect(config.simulator.enabled).toBe(true)
  })

  it('reads the deadline catch-up window and takes an env override (T8e)', () => {
    const config = loadEngineConfig({ env: {} })

    expect(config.engine.deadlines.catchUpWindowMs).toBeGreaterThan(0)
    expect(config.engine.provisional).toContain('deadlines.catchUpWindowMs')
    expect(
      loadEngineConfig({ env: { VL_DEADLINE_CATCH_UP_MS: '60000' } }).engine.deadlines
        .catchUpWindowMs,
    ).toBe(60_000)
  })

  it('refuses a missing section rather than inventing a default', () => {
    const path = writeConfig({ input: {} })

    expect(() => loadEngineConfig({ configPath: path, env: {} })).toThrow(
      /engine must be an object/,
    )
  })

  it('refuses a non-positive interval', () => {
    const base = repoConfig()
    const engine = { ...(base['engine'] as Record<string, unknown>), tickIntervalMs: 0 }
    const path = writeConfig({ ...base, engine })

    expect(() => loadEngineConfig({ configPath: path, env: {} })).toThrow(
      /tickIntervalMs must be greater than 0/,
    )
  })
})
