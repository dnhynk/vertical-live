import { describe, expect, it } from 'vitest'

import { EnvSecretProvider } from './env.js'
import { MissingSecretError, requireSecret, SECRET_NAMES, type SecretProvider } from './types.js'

const TEST_VALUE = 'test-obs-websocket-password'

describe('EnvSecretProvider', () => {
  it('reads each spec §10.2 secret from its own environment variable', async () => {
    const provider = new EnvSecretProvider({
      VL_OBS_PASSWORD: TEST_VALUE,
      VL_YOUTUBE_REFRESH_TOKEN: 'test-refresh-token',
      VL_YOUTUBE_STREAM_KEY: 'test-stream-key',
      VL_ADMIN_TOKEN: 'test-admin-token',
      VL_SIMULATOR_TOKEN: 'test-simulator-token',
      VL_RENDERER_TOKEN: 'test-renderer-token',
      // T12's operator channels: every URL carries its token in the path.
      VL_SLACK_WEBHOOK_URL: 'test-slack-webhook-url',
      VL_DISCORD_WEBHOOK_URL: 'test-discord-webhook-url',
      VL_DEAD_MAN_PUSH_URL: 'test-dead-man-push-url',
    })

    for (const name of SECRET_NAMES) {
      await expect(provider.get(name)).resolves.toMatch(/^test-/)
    }
    expect(provider.source).toBe('env')
  })

  it('treats an unset or empty variable as not configured', async () => {
    const provider = new EnvSecretProvider({ VL_OBS_PASSWORD: '' })

    await expect(provider.get('obs.websocketPassword')).resolves.toBeUndefined()
    await expect(provider.get('server.adminToken')).resolves.toBeUndefined()
  })

  it('rejects a name that is not in the declared secret set', async () => {
    const provider = new EnvSecretProvider({})

    await expect(provider.get('obs.password' as never)).rejects.toThrow(/unknown secret name/)
  })

  it('names the environment variable a caller has to set', () => {
    expect(EnvSecretProvider.envVarFor('obs.websocketPassword')).toBe('VL_OBS_PASSWORD')
  })
})

describe('requireSecret', () => {
  it('returns the configured value', async () => {
    const provider = new EnvSecretProvider({ VL_OBS_PASSWORD: TEST_VALUE })

    await expect(requireSecret(provider, 'obs.websocketPassword')).resolves.toBe(TEST_VALUE)
  })

  it('throws MissingSecretError naming the secret and the provider', async () => {
    const provider = new EnvSecretProvider({})

    const error = await requireSecret(
      provider,
      'obs.websocketPassword',
      'set VL_OBS_PASSWORD',
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MissingSecretError)
    expect((error as MissingSecretError).secretName).toBe('obs.websocketPassword')
    expect((error as MissingSecretError).source).toBe('env')
    expect((error as Error).message).toContain('obs.websocketPassword')
    expect((error as Error).message).toContain('set VL_OBS_PASSWORD')
  })

  it('never puts a secret value in the error a caller may log (spec §10.2)', async () => {
    // The provider holds real values for the other secrets; the error raised for
    // the missing one must still carry names only.
    const provider: SecretProvider = {
      source: 'test-provider',
      get: async (name) => (name === 'youtube.streamKey' ? undefined : TEST_VALUE),
    }

    const error = (await requireSecret(provider, 'youtube.streamKey').catch(
      (caught: unknown) => caught,
    )) as Error

    expect(error.message).toContain('youtube.streamKey')
    expect(error.message).toContain('test-provider')
    expect(error.message).not.toContain(TEST_VALUE)
  })

  it('treats an empty string as missing rather than as a valid secret', async () => {
    const provider: SecretProvider = { source: 'test-provider', get: async () => '' }

    await expect(requireSecret(provider, 'server.adminToken')).rejects.toBeInstanceOf(
      MissingSecretError,
    )
  })
})
