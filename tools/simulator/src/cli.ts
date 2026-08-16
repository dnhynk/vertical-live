export const USAGE = `vl-simulator — @vl/simulator CLI (skeleton)

Usage:
  vl-simulator help    Show this message

Scenario injection, replay and latency reporting land in T11.`

export interface CliResult {
  readonly exitCode: number
  readonly output: string
}

const HELP_COMMANDS = new Set(['help', '--help', '-h'])

/** Pure command dispatch so both the accepted and the rejected path are testable. */
export function runCli(argv: readonly string[]): CliResult {
  const command = argv[0]

  if (command === undefined || HELP_COMMANDS.has(command)) {
    return { exitCode: 0, output: USAGE }
  }

  return { exitCode: 2, output: `unknown command: ${command}\n\n${USAGE}` }
}
