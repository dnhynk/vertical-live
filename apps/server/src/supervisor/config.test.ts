import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  assertModerationCallTableApproved,
  loadSupervisorConfig,
  ModerationCallTableNotApprovedError,
  SupervisorConfigError,
} from './config.js'
import { HEALTH_FAMILIES, SUPERVISED_COMPONENTS } from './types.js'

/**
 * `config/default.json` is the authority (TASK_SPECS 공통 규약) and every
 * threshold in it is provisional (BOARD A-15). These tests pin the shape and the
 * refusals, not the numbers.
 */

const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/default.json', import.meta.url),
)

/** The real file with only the `supervisor` block replaced. */
function configFileWith(supervisor: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'vl-supervisor-config-'))
  const path = join(directory, 'config.json')
  const real = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...real, supervisor }), 'utf8')
  return path
}

describe('loadSupervisorConfig', () => {
  it('loads the repository defaults', () => {
    const config = loadSupervisorConfig()

    expect(config.evaluateIntervalMs).toBeGreaterThan(0)
    expect(config.requiredFamilies.length).toBeGreaterThan(0)
    for (const family of config.requiredFamilies) {
      expect(HEALTH_FAMILIES).toContain(family)
    }
  })

  it('gives every supervised component an attempt budget', () => {
    const config = loadSupervisorConfig()

    for (const component of SUPERVISED_COMPONENTS) {
      expect(config.restart.maxAttempts[component]).toBeGreaterThan(0)
    }
  })

  it('marks the thresholds provisional (BOARD A-15)', () => {
    const config = loadSupervisorConfig()

    expect(config.provisional).toContain('restart')
    expect(config.provisional).toContain('renderer')
    expect(config.provisional).toContain('evaluateIntervalMs')
  })

  it('keeps the dead-man monitor and the screenshots off until an operator turns them on', () => {
    const config = loadSupervisorConfig()

    expect(config.deadMan.enabled).toBe(false)
    expect(config.screenshot.enabled).toBe(false)
  })

  it('takes env overrides for the deployment switches', () => {
    const config = loadSupervisorConfig({
      env: { VL_OBS_ENABLED: 'true', VL_BROADCAST_ENABLED: 'true', VL_DEAD_MAN_ENABLED: 'true' },
    })

    expect(config.integrations.obs).toBe(true)
    expect(config.integrations.broadcast).toBe(true)
    expect(config.deadMan.enabled).toBe(true)
  })

  it('refuses a component that has no attempt budget', () => {
    const config = loadSupervisorConfig()
    const withoutObsProcess = Object.fromEntries(
      Object.entries(config.restart.maxAttempts).filter(([name]) => name !== 'obs-process'),
    )
    const path = configFileWith({
      ...config,
      restart: { ...config.restart, maxAttempts: withoutObsProcess },
    })

    expect(() => loadSupervisorConfig({ configPath: path })).toThrow(SupervisorConfigError)
  })

  it('refuses an attempt budget for something that is not a component', () => {
    const config = loadSupervisorConfig()
    const path = configFileWith({
      ...config,
      restart: { ...config.restart, maxAttempts: { ...config.restart.maxAttempts, obs: 3 } },
    })

    expect(() => loadSupervisorConfig({ configPath: path })).toThrow(
      /is not a supervised component/,
    )
  })

  it('refuses an unknown health family in requiredFamilies', () => {
    const config = loadSupervisorConfig()
    const path = configFileWith({ ...config, requiredFamilies: ['obs_output', 'weather'] })

    expect(() => loadSupervisorConfig({ configPath: path })).toThrow(/unknown health family/)
  })
})

describe('moderation call table (spec §12.3, Gate 0)', () => {
  it('ships unapproved and empty', () => {
    const { moderation } = loadSupervisorConfig()

    expect(moderation.approved).toBe(false)
    expect(moderation.onCallOwner).toBeNull()
    expect(moderation.safeStopConditions).toEqual([])
  })

  it('refuses to report itself approved, and names what is missing', () => {
    const { moderation } = loadSupervisorConfig()

    expect(() => assertModerationCallTableApproved(moderation)).toThrow(
      ModerationCallTableNotApprovedError,
    )
    expect(() => assertModerationCallTableApproved(moderation)).toThrow(/onCallOwner/)
  })

  it('accepts a table an operator has filled in and approved', () => {
    expect(() =>
      assertModerationCallTableApproved({
        approved: true,
        onCallOwner: 'operations',
        maxResponseMinutes: 30,
        escalationChannel: 'discord',
        autoBlockScope: 'youtube blocked words + URL hold',
        safeStopConditions: ['moderation control unreachable'],
      }),
    ).not.toThrow()
  })
})
