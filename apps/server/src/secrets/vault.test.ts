import { describe, expect, it } from 'vitest'
import { InMemorySecretVault } from './memory.js'
import { SecretRedactor, createRedactingLogger, redactValues, REDACTED } from './redaction.js'
import { ALLOW_IN_MEMORY_VAULT_ENV, resolveSecretVault } from './resolve.js'
import { SecretVaultError, SecretVaultUnavailableError } from './vault.js'
import {
  WindowsCredentialManagerVault,
  type CredentialEntry,
  type CredentialEntryFactory,
} from './windows-credential-manager.js'
import type { SecretName } from './types.js'

const REFRESH_TOKEN: SecretName = 'youtube.oauthRefreshToken'
// Obvious synthetic value (CLAUDE.md §3: no real secrets in fixtures/tests).
const SYNTHETIC_REFRESH_TOKEN = 'synthetic-refresh-token-000000000000'

class FakeEntry implements CredentialEntry {
  constructor(
    private readonly store: Map<string, string>,
    private readonly key: string,
    private readonly failWith?: Error,
  ) {}

  async getPassword(): Promise<string | undefined | null> {
    if (this.failWith) throw this.failWith
    // Mirrors the observed @napi-rs/keyring behaviour: absent -> null, not throw.
    return this.store.get(this.key) ?? null
  }

  async setPassword(password: string): Promise<void> {
    if (this.failWith) throw this.failWith
    this.store.set(this.key, password)
  }

  async deleteCredential(): Promise<boolean> {
    if (this.failWith) throw this.failWith
    return this.store.delete(this.key)
  }
}

function fakeFactory(store: Map<string, string>, failWith?: Error): CredentialEntryFactory {
  return (service, account) => new FakeEntry(store, `${service}/${account}`, failWith)
}

describe('InMemorySecretVault', () => {
  it('round-trips, reports absence and deletes', async () => {
    const vault = new InMemorySecretVault()

    expect(await vault.get(REFRESH_TOKEN)).toBeUndefined()
    await vault.set(REFRESH_TOKEN, SYNTHETIC_REFRESH_TOKEN)
    expect(await vault.get(REFRESH_TOKEN)).toBe(SYNTHETIC_REFRESH_TOKEN)
    expect(vault.storedNames()).toEqual([REFRESH_TOKEN])

    expect(await vault.delete(REFRESH_TOKEN)).toBe(true)
    expect(await vault.delete(REFRESH_TOKEN)).toBe(false)
    expect(await vault.get(REFRESH_TOKEN)).toBeUndefined()
  })

  it('rejects unknown names and empty values', async () => {
    const vault = new InMemorySecretVault()
    await expect(vault.get('youtube.nope' as SecretName)).rejects.toThrow('unknown secret name')
    await expect(vault.set(REFRESH_TOKEN, '')).rejects.toThrow('refusing to store an empty secret')
  })
})

describe('WindowsCredentialManagerVault (injected binding)', () => {
  it('round-trips through the credential entry', async () => {
    const store = new Map<string, string>()
    const vault = await WindowsCredentialManagerVault.create({ entryFactory: fakeFactory(store) })

    expect(await vault.get(REFRESH_TOKEN)).toBeUndefined()
    await vault.set(REFRESH_TOKEN, SYNTHETIC_REFRESH_TOKEN)
    expect(store.get(`vertical-live/${REFRESH_TOKEN}`)).toBe(SYNTHETIC_REFRESH_TOKEN)
    expect(await vault.get(REFRESH_TOKEN)).toBe(SYNTHETIC_REFRESH_TOKEN)
    expect(await vault.delete(REFRESH_TOKEN)).toBe(true)
    expect(await vault.delete(REFRESH_TOKEN)).toBe(false)
  })

  it('refuses to construct off Windows', async () => {
    await expect(WindowsCredentialManagerVault.create({ platform: 'linux' })).rejects.toThrow(
      SecretVaultUnavailableError,
    )
  })

  it('keeps the secret value out of store errors', async () => {
    const failure = new Error(`wincred rejected the blob "${SYNTHETIC_REFRESH_TOKEN}"`)
    const vault = await WindowsCredentialManagerVault.create({
      entryFactory: fakeFactory(new Map(), failure),
    })

    const error = await vault.set(REFRESH_TOKEN, SYNTHETIC_REFRESH_TOKEN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SecretVaultError)
    expect((error as Error).message).not.toContain(SYNTHETIC_REFRESH_TOKEN)
    expect((error as Error).message).toContain(REDACTED)
    expect((error as Error).message).toContain(REFRESH_TOKEN)
  })

  it('rejects unknown secret names', async () => {
    const vault = await WindowsCredentialManagerVault.create({
      entryFactory: fakeFactory(new Map()),
    })
    await expect(vault.get('obs.nope' as SecretName)).rejects.toThrow('unknown secret name')
  })
})

describe('resolveSecretVault', () => {
  it('refuses an unencrypted fallback off Windows unless it is opted into', async () => {
    await expect(resolveSecretVault({ platform: 'linux', env: {} })).rejects.toThrow(
      SecretVaultUnavailableError,
    )

    const optedIn = await resolveSecretVault({
      platform: 'linux',
      env: { [ALLOW_IN_MEMORY_VAULT_ENV]: '1' },
    })
    expect(optedIn.source).toContain('in-memory')

    const underVitest = await resolveSecretVault({ platform: 'linux', env: { VITEST: 'true' } })
    expect(underVitest.source).toContain('in-memory')
  })
})

describe('SecretRedactor', () => {
  it('masks raw, url-encoded and json-escaped forms', () => {
    const redactor = new SecretRedactor()
    const value = 'synthetic/token+value=0123456789'
    expect(redactor.register(value)).toBe(true)

    expect(redactor.redact(`token=${value}`)).toBe(`token=${REDACTED}`)
    expect(redactor.redact(`body=${encodeURIComponent(value)}`)).toBe(`body=${REDACTED}`)
    expect(redactor.redact(JSON.stringify({ refresh_token: value }))).not.toContain(value)
  })

  it('skips values too short to mask safely', () => {
    const redactor = new SecretRedactor()
    expect(redactor.register('short')).toBe(false)
    expect(redactor.register(undefined)).toBe(false)
    expect(redactor.redact('short')).toBe('short')
  })

  it('masks logger messages, string fields and error stacks', () => {
    const lines: string[] = []
    const redactor = new SecretRedactor()
    redactor.register(SYNTHETIC_REFRESH_TOKEN)
    const logger = createRedactingLogger(
      {
        debug: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`),
        info: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`),
        warn: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`),
        error: (m, f) => lines.push(`${m} ${JSON.stringify(f)}`),
      },
      redactor,
    )

    logger.info(`refreshed with ${SYNTHETIC_REFRESH_TOKEN}`, {
      token: SYNTHETIC_REFRESH_TOKEN,
      attempt: 1,
    })
    logger.error('failed', { detail: redactor.redactError(new Error(SYNTHETIC_REFRESH_TOKEN)) })

    expect(lines.join('\n')).not.toContain(SYNTHETIC_REFRESH_TOKEN)
    expect(lines[0]).toContain(REDACTED)
    expect(lines[0]).toContain('"attempt":1')
  })

  it('redactValues masks one-shot without a long-lived redactor', () => {
    expect(redactValues(`k=${SYNTHETIC_REFRESH_TOKEN}`, [SYNTHETIC_REFRESH_TOKEN])).toBe(
      `k=${REDACTED}`,
    )
  })
})
