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
    provisional: ['maxRawLength'],
  },
}

describe('loadInputConfig', () => {
  it('reads the repository config and marks the tuning values provisional', () => {
    const config = loadInputConfig({ env: {} })
    expect(config.maxRawLength).toBeGreaterThan(0)
    expect(config.window.windowMs).toBeGreaterThan(0)
    // BOARD A-3/A-15: none of these are approved limits yet.
    expect(config.provisional).toEqual(
      expect.arrayContaining([
        'maxRawLength',
        'window.windowMs',
        'window.enterAggregateAtCommands',
        'window.exitAggregateAtCommands',
        'window.maxDirectPerWindow',
      ]),
    )
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
})
