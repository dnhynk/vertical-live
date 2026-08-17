import { describe, expect, it } from 'vitest'

import { CliError, parseFlags, runCli, USAGE } from './cli.js'
import { renderFaultMatrixDoc } from './matrix/doc.js'

/** The `vl-soak` command surface (TASK_SPECS §T15). */

describe('parseFlags', () => {
  it('defaults to the accelerated mode with the fault schedule on', () => {
    const flags = parseFlags(['run'])
    expect(flags.command).toBe('run')
    expect(flags.mode).toBe('accelerated')
    expect(flags.faults).toBe(true)
    expect(flags.reportPath).toBeNull()
  })

  it('reads every flag the runbook documents', () => {
    const flags = parseFlags([
      'run',
      '--mode',
      'realtime',
      '--duration-ms',
      '600000',
      '--slice-ms',
      '2500',
      '--no-faults',
      '--report',
      'data/diagnostics/soak/report.json',
      '--quiet',
    ])
    expect(flags).toEqual({
      command: 'run',
      write: false,
      mode: 'realtime',
      durationMs: 600_000,
      sliceMs: 2_500,
      faults: false,
      reportPath: 'data/diagnostics/soak/report.json',
      quiet: true,
    })
  })

  it('refuses an unknown mode, a missing value and an unknown flag', () => {
    expect(() => parseFlags(['run', '--mode', 'fast'])).toThrow(CliError)
    expect(() => parseFlags(['run', '--duration-ms'])).toThrow(CliError)
    expect(() => parseFlags(['run', '--report'])).toThrow(CliError)
    expect(() => parseFlags(['--nope'])).toThrow(CliError)
  })
})

describe('runCli', () => {
  it('prints usage with no arguments', async () => {
    await expect(runCli([])).resolves.toEqual({ exitCode: 0, output: USAGE })
  })

  it('prints the generated fault matrix without writing it', async () => {
    const result = await runCli(['matrix'])
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe(renderFaultMatrixDoc())
  })

  it('reports a bad flag with the usage instead of throwing', async () => {
    const result = await runCli(['run', '--mode', 'fast'])
    expect(result.exitCode).toBe(2)
    expect(result.output).toContain(USAGE)
  })

  it('runs a short soak and exits zero on a passing report', async () => {
    const result = await runCli([
      'run',
      '--mode',
      'accelerated',
      '--duration-ms',
      '1800000',
      '--slice-ms',
      '5000',
      '--no-faults',
      '--quiet',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('verdict:    PASS')
    expect(result.output).toContain('faults injected           none')
  }, 120_000)
})
