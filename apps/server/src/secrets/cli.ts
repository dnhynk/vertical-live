import { SecretRedactor } from './redaction.js'
import { SECRET_NAMES, type SecretName } from './types.js'
import type { SecretVault } from './vault.js'

/**
 * `secrets` CLI: puts the four spec §10.2 secrets into the vault
 * (`npm run secrets -w @vl/server -- set <name>`), lists which ones are set and
 * removes one.
 *
 * The value is read from stdin, never from argv: a command line ends up in the
 * shell history and in the process list, which is exactly the exposure the
 * vault exists to prevent. Nothing here ever prints a value — including on the
 * failure path, where the store's own error is masked with the value before it
 * reaches the terminal.
 */

export interface SecretsCliIo {
  write(line: string): void
  /** Reads the secret value; the CLI trims one trailing newline. */
  readStdin(): Promise<string>
}

export interface SecretsCliDeps {
  readonly io: SecretsCliIo
  readonly vault: SecretVault
}

const USAGE = `usage:
  secrets list                 show which secrets are set (never values)
  secrets set <name>           read the value from stdin and store it
  secrets delete <name>        remove the stored value

names: ${SECRET_NAMES.join(', ')}`

export async function runSecretsCli(
  argv: readonly string[],
  deps: SecretsCliDeps,
): Promise<number> {
  const [command, name] = argv
  const { io, vault } = deps

  if (command === undefined || command === '--help' || command === '-h') {
    io.write(USAGE)
    return command === undefined ? 1 : 0
  }

  if (command === 'list') {
    io.write(`vault: ${vault.source}`)
    for (const secret of SECRET_NAMES) {
      const present = (await vault.get(secret)) !== undefined
      io.write(`${present ? 'set    ' : 'missing'}  ${secret}`)
    }
    return 0
  }

  if (command !== 'set' && command !== 'delete') {
    io.write(`unknown command: ${command}\n${USAGE}`)
    return 1
  }

  const secretName = parseSecretName(name)
  if (secretName === undefined) {
    io.write(`unknown secret name: ${name ?? '(missing)'}\n${USAGE}`)
    return 1
  }

  if (command === 'delete') {
    try {
      const deleted = await vault.delete(secretName)
      io.write(deleted ? `deleted ${secretName}` : `nothing stored under ${secretName}`)
      return 0
    } catch (error) {
      io.write(`delete failed: ${new SecretRedactor().redactError(error)}`)
      return 1
    }
  }

  const value = stripTrailingNewline(await deps.io.readStdin())
  if (value === '') {
    io.write(`refusing to store an empty value for ${secretName}`)
    return 1
  }
  // Registered before the write: if the store echoes the value back in an
  // error, the echo is masked on its way to the terminal.
  const redactor = new SecretRedactor()
  redactor.register(value)
  try {
    await vault.set(secretName, value)
  } catch (error) {
    io.write(`store failed: ${redactor.redactError(error)}`)
    return 1
  }
  io.write(`stored ${secretName} (${value.length} characters) in ${vault.source}`)
  return 0
}

export function parseSecretName(name: string | undefined): SecretName | undefined {
  if (name === undefined) {
    return undefined
  }
  return (SECRET_NAMES as readonly string[]).includes(name) ? (name as SecretName) : undefined
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, '')
}
