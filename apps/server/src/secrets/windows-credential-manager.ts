import { redactValues } from './redaction.js'
import { SECRET_NAMES, type SecretName } from './types.js'
import { SecretVaultError, SecretVaultUnavailableError, type SecretVault } from './vault.js'

/**
 * Windows Credential Manager vault (spec §10.2: OAuth refresh token, stream key
 * and OBS password live in the OS credential vault, never in the repository,
 * the DB, logs or on screen; D-2 fixes Windows 11 as the first host).
 *
 * The binding is `@napi-rs/keyring` — see `docs/tasks/TASK-T3-auth-vault.md`
 * for the candidate comparison. Under the hood each entry becomes a Windows
 * generic credential, encrypted at rest per user account by DPAPI.
 */

/** Credential Manager "service" the entries are grouped under. */
export const DEFAULT_CREDENTIAL_SERVICE = 'vertical-live'

/** Subset of `@napi-rs/keyring`'s `AsyncEntry` this vault uses. */
export interface CredentialEntry {
  getPassword(): Promise<string | undefined | null>
  setPassword(password: string): Promise<void>
  deleteCredential(): Promise<boolean>
}

export type CredentialEntryFactory = (service: string, account: SecretName) => CredentialEntry

export interface WindowsCredentialManagerVaultOptions {
  /** Credential Manager service name; default `vertical-live`. */
  readonly service?: string
  /** Defaults to `process.platform`; tests use it to exercise the reject path. */
  readonly platform?: NodeJS.Platform
  /** Defaults to `@napi-rs/keyring`'s `AsyncEntry`. Injected in unit tests. */
  readonly entryFactory?: CredentialEntryFactory
}

export class WindowsCredentialManagerVault implements SecretVault {
  readonly source = 'windows-credential-manager'
  readonly service: string
  readonly #entryFactory: CredentialEntryFactory

  private constructor(service: string, entryFactory: CredentialEntryFactory) {
    this.service = service
    this.#entryFactory = entryFactory
  }

  /**
   * Loads the native binding and returns a vault, or throws
   * `SecretVaultUnavailableError` when this host cannot provide one (non
   * Windows, or the platform binary is missing). Callers decide the fallback;
   * this class never silently degrades to an unencrypted store.
   */
  static async create(
    options: WindowsCredentialManagerVaultOptions = {},
  ): Promise<WindowsCredentialManagerVault> {
    const service = options.service ?? DEFAULT_CREDENTIAL_SERVICE
    if (options.entryFactory !== undefined) {
      return new WindowsCredentialManagerVault(service, options.entryFactory)
    }

    const platform = options.platform ?? process.platform
    if (platform !== 'win32') {
      throw new SecretVaultUnavailableError(
        'windows-credential-manager',
        `Windows Credential Manager needs win32, host is ${platform}`,
      )
    }

    let AsyncEntry: new (service: string, account: string) => CredentialEntry
    try {
      ;({ AsyncEntry } = await import('@napi-rs/keyring'))
    } catch (error) {
      throw new SecretVaultUnavailableError(
        'windows-credential-manager',
        `cannot load @napi-rs/keyring: ${(error as Error).message}`,
      )
    }
    return new WindowsCredentialManagerVault(service, (svc, account) => new AsyncEntry(svc, account))
  }

  async get(name: SecretName): Promise<string | undefined> {
    const entry = this.#entryFor(name, 'get')
    try {
      // Absent credential: the binding resolves null/undefined rather than throwing.
      const value = await entry.getPassword()
      return value === null || value === undefined || value === '' ? undefined : value
    } catch (error) {
      throw new SecretVaultError(this.source, 'get', name, describe(error))
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    if (value === '') {
      throw new Error(`refusing to store an empty secret: ${name}`)
    }
    const entry = this.#entryFor(name, 'set')
    try {
      await entry.setPassword(value)
    } catch (error) {
      // The store is handed the value, so a store error could echo it back.
      throw new SecretVaultError(this.source, 'set', name, describe(error, value))
    }
  }

  async delete(name: SecretName): Promise<boolean> {
    const entry = this.#entryFor(name, 'delete')
    try {
      return await entry.deleteCredential()
    } catch (error) {
      throw new SecretVaultError(this.source, 'delete', name, describe(error))
    }
  }

  #entryFor(name: SecretName, operation: 'get' | 'set' | 'delete'): CredentialEntry {
    if (!(SECRET_NAMES as readonly string[]).includes(name)) {
      throw new SecretVaultError(this.source, operation, name, 'unknown secret name')
    }
    return this.#entryFactory(this.service, name)
  }
}

function describe(error: unknown, secretValue?: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return secretValue === undefined ? message : redactValues(message, [secretValue])
}
