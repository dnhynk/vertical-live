import { describe, expect, it } from 'vitest'

import { allScenarios, parseFlags, runCli, USAGE } from './cli.js'
import { requiresParser } from './scenario/index.js'

describe('runCli', () => {
  it('prints usage and exits 0 with no arguments', async () => {
    expect(await runCli([])).toEqual({ exitCode: 0, output: USAGE })
  })

  it('prints usage and exits 0 for help', async () => {
    expect(await runCli(['help'])).toEqual({ exitCode: 0, output: USAGE })
    expect(await runCli(['--help'])).toEqual({ exitCode: 0, output: USAGE })
  })

  it('rejects an unknown command with a non-zero exit code', async () => {
    const result = await runCli(['launch-nukes'])

    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('unknown command: launch-nukes')
  })

  it('lists every scenario of TASK_SPECS §T11 with its flags', async () => {
    const result = await runCli(['list'])

    expect(result.exitCode).toBe(0)
    for (const id of [
      'idle-24h',
      'direct-low',
      'aggregate-switch',
      'flood',
      'paid-replay',
      'degraded-window',
      'adversarial',
    ]) {
      expect(result.output).toContain(id)
    }
    expect(result.output).toContain('virtual-clock')
    expect(result.output).toContain('needs-parser')
  })

  it('refuses run without a scenario reference', async () => {
    const result = await runCli(['run'])

    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('run needs a scenario id or file path')
  })

  it('refuses an unreadable scenario file instead of inventing one', async () => {
    const result = await runCli(['run', './no-such-scenario.json'])

    expect(result.exitCode).toBe(1)
    expect(result.output.startsWith('error:')).toBe(true)
  })

  it('refuses --url without a token: the endpoint is authenticated', async () => {
    const result = await runCli(['run', 'direct-low', '--url', 'http://127.0.0.1:8787'])

    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('--token')
  })

  it('refuses to run a virtual-clock scenario against a live server', async () => {
    const result = await runCli([
      'run',
      'idle-24h',
      '--url',
      'http://127.0.0.1:8787',
      '--token',
      'sim_token_test',
    ])

    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('needs a virtual clock')
  })
})

describe('parseFlags', () => {
  it('reads flags with and without a value', () => {
    expect(parseFlags(['--json', '--clock', 'system'])).toEqual(
      new Map([
        ['json', ''],
        ['clock', 'system'],
      ]),
    )
  })

  it('refuses a bare argument rather than ignoring it', () => {
    expect(() => parseFlags(['oops'])).toThrow('unexpected argument: oops')
  })
})

describe('allScenarios', () => {
  it('has exactly one parser-dependent scenario, and it is the adversarial one', () => {
    const needingParser = allScenarios().filter(requiresParser)

    expect(needingParser.map((scenario) => scenario.id)).toEqual(['adversarial'])
  })
})
