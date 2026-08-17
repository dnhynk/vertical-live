import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadSoakConfig, SoakConfigError } from './config.js'

const REAL_CONFIG = fileURLToPath(new URL('../../../config/default.json', import.meta.url))

/**
 * The soak's own configuration contract (TASK_SPECS §T15: "합격선 숫자는 Gate 0/2
 * 승인값을 config로 받는다(임의값 금지, provisional 라벨)").
 */

describe('loadSoakConfig', () => {
  it('reads both run shapes from config/default.json', () => {
    const config = loadSoakConfig({ env: {} })

    // Spec §11's soak is 72 hours; both modes describe the same run.
    expect(config.accelerated.durationMs).toBe(72 * 60 * 60 * 1000)
    expect(config.realtime.durationMs).toBe(72 * 60 * 60 * 1000)
    expect(config.accelerated.sliceMs).toBeGreaterThan(0)
    expect(config.accelerated.injectIntervalMs).toBeGreaterThan(0)
    expect(config.accelerated.faultIntervalMs).toBeGreaterThan(0)
  })

  it('leaves every spec §11 threshold unlocked (BOARD A-15)', () => {
    const config = loadSoakConfig({ env: {} })

    // Not "0", not a guess: `null` says Gate 0/2 has not approved a value.
    expect(config.thresholds).toEqual({
      maxContinuousOutageMs: null,
      maxRecoveryMs: null,
      maxFreezeEvents: null,
      maxAlertDeliveryMs: null,
      endToEndP95Ms: null,
      minBroadcastAvailability: null,
      minInteractionAvailability: null,
    })
    expect(config.provisional).toContain('thresholds')
  })

  it('accepts a locked threshold once one is approved', () => {
    const configPath = writeConfig({ thresholds: { maxContinuousOutageMs: 30_000 } })
    expect(loadSoakConfig({ configPath, env: {} }).thresholds.maxContinuousOutageMs).toBe(30_000)
  })

  it('takes the duration and slice from the environment', () => {
    const config = loadSoakConfig({
      env: { VL_SOAK_DURATION_MS: '600000', VL_SOAK_SLICE_MS: '2500' },
    })
    expect(config.accelerated.durationMs).toBe(600_000)
    expect(config.accelerated.sliceMs).toBe(2_500)
    // The realtime shape is not overridden by the accelerated environment.
    expect(config.realtime.durationMs).toBe(72 * 60 * 60 * 1000)
  })

  it('refuses a malformed section instead of falling back to a default', () => {
    expect(() => loadSoakConfig({ configPath: writeConfig({ sliceMs: 0 }), env: {} })).toThrow(
      SoakConfigError,
    )
    expect(() =>
      loadSoakConfig({ configPath: writeConfig({ thresholds: { endToEndP95Ms: -1 } }), env: {} }),
    ).toThrow(SoakConfigError)
    expect(() =>
      loadSoakConfig({
        configPath: writeConfig({ thresholds: { minBroadcastAvailability: 1.5 } }),
        env: {},
      }),
    ).toThrow(SoakConfigError)
  })
})

interface Overrides {
  readonly sliceMs?: number
  readonly thresholds?: Record<string, number>
}

/** A copy of the real config with one field changed, written to a temp file. */
function writeConfig(overrides: Overrides): string {
  const source = JSON.parse(readFileSync(REAL_CONFIG, 'utf8')) as Record<string, unknown>
  const soak = source['soak'] as Record<string, unknown>
  const accelerated = soak['accelerated'] as Record<string, unknown>
  source['soak'] = {
    ...soak,
    accelerated: {
      ...accelerated,
      ...(overrides.sliceMs === undefined ? {} : { sliceMs: overrides.sliceMs }),
    },
    thresholds: { ...(soak['thresholds'] as object), ...overrides.thresholds },
  }
  const file = join(mkdtempSync(join(tmpdir(), 'vl-soak-config-')), 'default.json')
  writeFileSync(file, JSON.stringify(source), 'utf8')
  return file
}
