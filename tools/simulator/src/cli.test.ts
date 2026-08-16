import { describe, expect, it } from 'vitest'

import { runCli, USAGE } from './cli.js'

describe('runCli', () => {
  it('prints usage and exits 0 with no arguments', () => {
    expect(runCli([])).toEqual({ exitCode: 0, output: USAGE })
  })

  it('prints usage and exits 0 for help', () => {
    expect(runCli(['help'])).toEqual({ exitCode: 0, output: USAGE })
    expect(runCli(['--help'])).toEqual({ exitCode: 0, output: USAGE })
  })

  it('rejects an unknown command with a non-zero exit code', () => {
    const result = runCli(['launch-nukes'])

    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('unknown command: launch-nukes')
  })
})
