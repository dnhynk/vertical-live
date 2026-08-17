import { afterEach, describe, expect, it } from 'vitest'
import { WindowsCredentialManagerVault } from './windows-credential-manager.js'
import type { SecretName } from './types.js'

/**
 * Acceptance criterion 2 (`docs/tasks/TASK_SPECS.md` §T3): vault round-trip
 * against the real Windows Credential Manager on Windows, against the
 * in-memory fallback elsewhere (covered in `vault.test.ts`). CI runs on
 * ubuntu-latest, so this file reports itself as skipped there instead of
 * pretending the store was exercised.
 */
const isWindows = process.platform === 'win32'

// Throwaway service name so the test never touches the operational entries.
const TEST_SERVICE = `vertical-live-test-${process.pid}`
const NAME: SecretName = 'youtube.oauthRefreshToken'
const SYNTHETIC_VALUE = 'synthetic-refresh-token-live-000000'
const SYNTHETIC_ROTATED = 'synthetic-refresh-token-live-111111'

describe.skipIf(!isWindows)('Windows Credential Manager round-trip (win32 only)', () => {
  afterEach(async () => {
    const vault = await WindowsCredentialManagerVault.create({ service: TEST_SERVICE })
    await vault.delete(NAME).catch(() => false)
  })

  it('stores, reads back, overwrites and deletes a credential', async () => {
    const vault = await WindowsCredentialManagerVault.create({ service: TEST_SERVICE })
    expect(vault.source).toBe('windows-credential-manager')

    expect(await vault.get(NAME)).toBeUndefined()

    await vault.set(NAME, SYNTHETIC_VALUE)
    expect(await vault.get(NAME)).toBe(SYNTHETIC_VALUE)

    // Rotation overwrites in place rather than creating a second credential.
    await vault.set(NAME, SYNTHETIC_ROTATED)
    expect(await vault.get(NAME)).toBe(SYNTHETIC_ROTATED)

    expect(await vault.delete(NAME)).toBe(true)
    expect(await vault.get(NAME)).toBeUndefined()
    expect(await vault.delete(NAME)).toBe(false)
  })

  it('reads back a value written by a separate vault instance', async () => {
    const writer = await WindowsCredentialManagerVault.create({ service: TEST_SERVICE })
    await writer.set(NAME, SYNTHETIC_VALUE)

    const reader = await WindowsCredentialManagerVault.create({ service: TEST_SERVICE })
    expect(await reader.get(NAME)).toBe(SYNTHETIC_VALUE)
  })
})

describe.skipIf(isWindows)('Windows Credential Manager off Windows', () => {
  it('is unavailable and says so', async () => {
    await expect(WindowsCredentialManagerVault.create()).rejects.toThrow(
      'secret vault unavailable: windows-credential-manager',
    )
  })
})
