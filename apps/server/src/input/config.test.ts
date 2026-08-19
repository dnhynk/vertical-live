import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { InputConfigError, loadInputConfig, parserLimits } from './config.js'

function writeConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'vl-input-config-'))
  const path = join(dir, 'default.json')
  writeFileSync(path, JSON.stringify(contents), 'utf8')
  return path
}

const VALID = {
  input: {
    maxRawLength: 500,
    window: {
      windowMs: 5000,
      enterAggregateAtCommands: 30,
      exitAggregateAtCommands: 10,
      maxDirectPerWindow: 20,
    },
    perUser: { cooldownMs: 5000 },
    provisional: ['maxRawLength'],
  },
}

describe('loadInputConfig', () => {
  it('reads the repository config with the Gate 0 approved window values (D-11)', () => {
    const config = loadInputConfig({ env: {} })

    // BOARD D-11 (2026-08-19) approved these four exactly; they are no longer
    // starting values a reader may re-tune at will.
    expect(config.window).toEqual({
      windowMs: 5000,
      maxDirectPerWindow: 20,
      enterAggregateAtCommands: 30,
      exitAggregateAtCommands: 10,
    })
  })

  it('lists maxRawLength and the consent cooldown as provisional (D-11, D-9)', () => {
    const config = loadInputConfig({ env: {} })

    // D-11 took `window.*` off the provisional list; `maxRawLength` has no
    // approved value yet, and neither does the consented-viewer cooldown D-9/A-9
    // introduced — spec §6.4 fixes no number for it (BOARD A-15).
    expect(config.provisional).toEqual(['maxRawLength', 'perUser.cooldownMs'])
    for (const key of config.provisional) {
      expect(key.startsWith('window.')).toBe(false)
    }
    expect(config.perUser.cooldownMs).toBeGreaterThan(0)
  })

  it('applies env overrides', () => {
    const config = loadInputConfig({
      configPath: writeConfig(VALID),
      env: { VL_INPUT_WINDOW_MS: '2500', VL_INPUT_MAX_RAW_LENGTH: '120' },
    })
    expect(config.window.windowMs).toBe(2500)
    expect(config.maxRawLength).toBe(120)
  })

  it('narrows to the parser limits without the arbiter settings', () => {
    const config = loadInputConfig({ configPath: writeConfig(VALID), env: {} })
    expect(parserLimits(config)).toEqual({ maxRawLength: 500 })
  })
})

describe('rejected configuration', () => {
  it('reports a missing file', () => {
    expect(() =>
      loadInputConfig({ configPath: join(tmpdir(), 'vl-missing.json'), env: {} }),
    ).toThrow(InputConfigError)
  })

  it('reports a missing input section', () => {
    expect(() => loadInputConfig({ configPath: writeConfig({ obs: {} }), env: {} })).toThrow(
      /missing "input" section/,
    )
  })

  it('reports a non-integer value', () => {
    const path = writeConfig({
      input: { ...VALID.input, window: { ...VALID.input.window, windowMs: 'soon' } },
    })
    expect(() => loadInputConfig({ configPath: path, env: {} })).toThrow(
      /windowMs must be an integer/,
    )
  })

  it('reports thresholds that cannot produce hysteresis', () => {
    const path = writeConfig({
      input: { ...VALID.input, window: { ...VALID.input.window, exitAggregateAtCommands: 99 } },
    })
    expect(() => loadInputConfig({ configPath: path, env: {} })).toThrow(/must not exceed/)
  })

  it('rejects an env override that is not a number', () => {
    expect(() =>
      loadInputConfig({ configPath: writeConfig(VALID), env: { VL_INPUT_WINDOW_MS: 'later' } }),
    ).toThrow(InputConfigError)
  })

  it('reports a missing perUser section', () => {
    // The consented-viewer rules of BOARD D-9 are not optional settings with a
    // silent default: a missing section would leave the cooldown unspecified
    // while the code still claims to enforce one.
    const withoutPerUser: Record<string, unknown> = { ...VALID.input }
    delete withoutPerUser['perUser']
    expect(() =>
      loadInputConfig({ configPath: writeConfig({ input: withoutPerUser }), env: {} }),
    ).toThrow(/input\.perUser must be an object/)
  })

  it('reports a negative per-user cooldown', () => {
    const path = writeConfig({ input: { ...VALID.input, perUser: { cooldownMs: -1 } } })
    expect(() => loadInputConfig({ configPath: path, env: {} })).toThrow(
      /input\.perUser\.cooldownMs must not be negative/,
    )
  })
})
