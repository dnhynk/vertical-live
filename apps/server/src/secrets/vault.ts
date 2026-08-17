import type { SecretName, SecretProvider } from './types.js'

/**
 * Writable secret store (spec §10.2). `SecretProvider` stays the read-only view
 * every consumer sees; only three paths write: the `auth:login` CLI, the token
 * manager's refresh-token rotation, and T13's revocation cleanup. Keeping the
 * write surface in a separate interface means a module that merely reads a
 * secret cannot overwrite or delete one.
 */
export interface SecretVault extends SecretProvider {
  set(name: SecretName, value: string): Promise<void>
  /** Resolves false when nothing was stored under `name`. */
  delete(name: SecretName): Promise<boolean>
}

/**
 * Thrown when the requested vault cannot run here (wrong OS, missing native
 * binding). The message names the provider and the reason, never a value.
 */
export class SecretVaultUnavailableError extends Error {
  readonly source: string

  constructor(source: string, reason: string) {
    super(`secret vault unavailable: ${source} — ${reason}`)
    this.name = 'SecretVaultUnavailableError'
    this.source = source
  }
}

/**
 * Thrown when the underlying store rejects a read/write. Callers may log it:
 * the constructor redacts the secret value out of the underlying message so a
 * store that echoes what it was handed cannot leak through an error path.
 */
export class SecretVaultError extends Error {
  readonly source: string
  readonly secretName: SecretName
  readonly operation: 'get' | 'set' | 'delete'

  constructor(
    source: string,
    operation: 'get' | 'set' | 'delete',
    secretName: SecretName,
    detail: string,
  ) {
    super(`secret vault ${operation} failed: ${secretName} (provider: ${source}) — ${detail}`)
    this.name = 'SecretVaultError'
    this.source = source
    this.secretName = secretName
    this.operation = operation
  }
}
