import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvSecretProvider, MissingSecretError } from '../secrets/index.js'
import { FakeClock } from '../testing/fake-clock.js'
import { FakeObsServer } from '../testing/fake-obs-server.js'
import { TEST_OBS_PASSWORD, testObsConfig } from '../testing/obs-test-support.js'
import { ObsClient } from './client.js'
import { ObsCommandError, ObsCommandVerificationError, ObsControl } from './control.js'
import { BROWSER_SOURCE_REFRESH_PROPERTY, CUSTOM_STREAM_SERVICE_TYPE } from './protocol.js'

/** Obviously synthetic (CLAUDE.md §3); no real stream key reaches a test. */
const TEST_STREAM_KEY = 'test-youtube-stream-key'
const TEST_INGEST_URL = 'rtmps://test-ingest.invalid:443/live2'

let server: FakeObsServer
let client: ObsClient

/** Auto-advancing so the verification loop's sleeps resolve without real time. */
function control(overrides = {}, secrets?: EnvSecretProvider): ObsControl {
  return new ObsControl({
    source: client,
    config: testObsConfig(server.url, overrides),
    clock: new FakeClock({ autoAdvance: true }),
    secrets: secrets ?? new EnvSecretProvider({ VL_YOUTUBE_STREAM_KEY: TEST_STREAM_KEY }),
  })
}

function requestTypes(): string[] {
  return server.requestLog.map((entry) => entry.requestType)
}

beforeEach(async () => {
  server = await FakeObsServer.start({ password: TEST_OBS_PASSWORD })
  client = new ObsClient({
    config: testObsConfig(server.url),
    secrets: new EnvSecretProvider({ VL_OBS_PASSWORD: TEST_OBS_PASSWORD }),
    clock: new FakeClock(),
  })
  await client.connect()
})

afterEach(async () => {
  await client.disconnect()
  await server.close()
})

describe('ObsControl stream commands', () => {
  it('starts the stream and verifies that the output became active', async () => {
    const result = await control().startStream()

    expect(result).toEqual({ outputActive: true, changed: true })
    expect(server.state.streamStatus.outputActive).toBe(true)
    expect(requestTypes()).toContain('StartStream')
  })

  it('waits out the OBS starting window before reporting success', async () => {
    server.state.startStreamLatencySamples = 3

    const result = await control().startStream()

    expect(result).toEqual({ outputActive: true, changed: true })
    expect(requestTypes().filter((type) => type === 'GetStreamStatus').length).toBeGreaterThan(3)
  })

  it('fails instead of claiming success when the output never becomes active', async () => {
    server.state.startStreamLatencySamples = 10_000

    await expect(control().startStream()).rejects.toBeInstanceOf(ObsCommandVerificationError)
    expect(server.state.streamStatus.outputActive).toBe(false)
  })

  it('is idempotent: an already-active output is reported, not restarted', async () => {
    server.state.streamStatus.outputActive = true

    const result = await control().startStream()

    expect(result).toEqual({ outputActive: true, changed: false })
    expect(requestTypes()).not.toContain('StartStream')
  })

  it('stops the stream and verifies that the output went inactive', async () => {
    server.state.streamStatus.outputActive = true

    const result = await control().stopStream()

    expect(result).toEqual({ outputActive: false, changed: true })
    expect(server.state.streamStatus.outputActive).toBe(false)
    expect(requestTypes()).toContain('StopStream')
  })

  it('is idempotent when the output is already stopped', async () => {
    const result = await control().stopStream()

    expect(result).toEqual({ outputActive: false, changed: false })
    expect(requestTypes()).not.toContain('StopStream')
  })
})

describe('ObsControl browser source refresh', () => {
  it('presses refreshnocache on the renderer browser source', async () => {
    const result = await control().refreshBrowserSource('test-browser-source')

    expect(result).toEqual({ inputName: 'test-browser-source', inputKind: 'browser_source' })
    expect(server.buttonPresses).toEqual([
      { inputName: 'test-browser-source', propertyName: BROWSER_SOURCE_REFRESH_PROPERTY },
    ])
  })

  it('defaults to the configured browser source name', async () => {
    await control({ browserSourceName: 'test-browser-source' }).refreshBrowserSource()

    expect(server.buttonPresses).toHaveLength(1)
  })

  it('refuses an input that is not a browser source, without sending the press', async () => {
    await expect(control().refreshBrowserSource('test-color-source')).rejects.toMatchObject({
      name: 'ObsCommandError',
      reason: 'not_a_browser_source',
    })
    expect(requestTypes()).not.toContain('PressInputPropertiesButton')
    expect(server.buttonPresses).toEqual([])
  })

  it('refuses an input that does not exist', async () => {
    await expect(control().refreshBrowserSource('test-missing-source')).rejects.toMatchObject({
      name: 'ObsCommandError',
      reason: 'input_not_found',
    })
    expect(requestTypes()).not.toContain('PressInputPropertiesButton')
  })
})

describe('ObsControl scene switching', () => {
  it('switches the program scene and verifies it became current', async () => {
    const result = await control().switchScene('test-scene-standby')

    expect(result).toEqual({ sceneName: 'test-scene-standby', changed: true })
    expect(server.state.currentProgramSceneName).toBe('test-scene-standby')
    expect(requestTypes()).toContain('SetCurrentProgramScene')
    expect(requestTypes()).toContain('GetCurrentProgramScene')
  })

  it('does nothing when the scene is already current', async () => {
    const result = await control().switchScene('test-scene-live')

    expect(result).toEqual({ sceneName: 'test-scene-live', changed: false })
    expect(requestTypes()).not.toContain('SetCurrentProgramScene')
  })

  it('refuses an unknown scene, without sending the switch', async () => {
    await expect(control().switchScene('test-scene-missing')).rejects.toBeInstanceOf(
      ObsCommandError,
    )
    expect(requestTypes()).not.toContain('SetCurrentProgramScene')
    expect(server.state.currentProgramSceneName).toBe('test-scene-live')
  })
})

describe('ObsControl stream service injection', () => {
  // Review round 1 finding 2. The operator never types the stream key into OBS;
  // the vault holds it and the server pushes it in before going live
  // (spec §10.2).
  it('injects the ingestion URL and the vault stream key as a custom service', async () => {
    const result = await control({ streamIngestUrl: TEST_INGEST_URL }).setStreamServiceFromVault()

    expect(result).toEqual({
      streamServiceType: CUSTOM_STREAM_SERVICE_TYPE,
      server: TEST_INGEST_URL,
      keyConfigured: true,
    })
    expect(requestTypes()).toContain('SetStreamServiceSettings')

    const sent = server.requestLog.find((entry) => entry.requestType === 'SetStreamServiceSettings')
      ?.requestData as { streamServiceType: string; streamServiceSettings: Record<string, unknown> }
    expect(sent.streamServiceType).toBe(CUSTOM_STREAM_SERVICE_TYPE)
    expect(sent.streamServiceSettings).toEqual({ server: TEST_INGEST_URL, key: TEST_STREAM_KEY })

    // OBS really holds it afterwards — that is the honest cost of injection,
    // documented in docs/ops/obs-setup.md.
    expect(server.state.streamService.streamServiceSettings['key']).toBe(TEST_STREAM_KEY)
  })

  it('never returns the key, and reports only whether one is configured', () => {
    // The result type is what a caller may log; a key must not be reachable
    // through it (spec §10.2, CLAUDE.md §3).
    return control({ streamIngestUrl: TEST_INGEST_URL })
      .setStreamServiceFromVault()
      .then((result) => {
        expect(JSON.stringify(result)).not.toContain(TEST_STREAM_KEY)
        expect(Object.keys(result).sort()).toEqual(['keyConfigured', 'server', 'streamServiceType'])
      })
  })

  it('refuses when the vault has no stream key, without contacting OBS', async () => {
    const commands = control({ streamIngestUrl: TEST_INGEST_URL }, new EnvSecretProvider({}))

    await expect(commands.setStreamServiceFromVault()).rejects.toBeInstanceOf(MissingSecretError)
    expect(requestTypes()).not.toContain('SetStreamServiceSettings')
  })

  it('does not read the environment when no provider is injected', async () => {
    // Review round 1, B1: T2's env provider was still the operational default
    // after T3, so `VL_YOUTUBE_STREAM_KEY` could stand in for the vault. The
    // default is `defaultSecretProvider()` (Windows Credential Manager) now, so
    // this call must fail — with the vault missing the key on Windows, or with
    // the vault being unavailable elsewhere — and never return the env value.
    const envKey = 'synthetic-env-stream-key-must-not-be-used'
    process.env['VL_YOUTUBE_STREAM_KEY'] = envKey
    try {
      const commands = new ObsControl({
        source: client,
        config: testObsConfig(server.url, { streamIngestUrl: TEST_INGEST_URL }),
        clock: new FakeClock({ autoAdvance: true }),
      })

      const error = await commands.setStreamServiceFromVault().catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(envKey)
      expect(requestTypes()).not.toContain('SetStreamServiceSettings')
    } finally {
      delete process.env['VL_YOUTUBE_STREAM_KEY']
    }
  })

  it('keeps the key out of the missing-secret error message', async () => {
    const commands = control({ streamIngestUrl: TEST_INGEST_URL }, new EnvSecretProvider({}))

    await expect(commands.setStreamServiceFromVault()).rejects.toThrow(
      /secret not configured: youtube\.streamKey \(provider: env\)/,
    )
  })

  it('describes the vault as system of record without claiming OBS never holds the key', async () => {
    // Review round 2 finding 1. This message is operator-visible, so BOARD A-16
    // governs its wording: the vault is the system of record and the repository
    // is excluded, but OBS caching the injected key in the active profile's
    // service.json must be acknowledged rather than denied.
    const commands = control({ streamIngestUrl: TEST_INGEST_URL }, new EnvSecretProvider({}))

    const error = await commands.setStreamServiceFromVault().catch((caught: unknown) => caught)
    const message = (error as Error).message

    expect(message).toContain('VL_YOUTUBE_STREAM_KEY')
    expect(message).toContain('system of record')
    expect(message).toContain('service.json')
    expect(message).not.toMatch(/not in OBS|only in the vault/)
  })

  it('fails when OBS did not apply the service, and the error carries no key', async () => {
    // OBS acknowledges the write but reports something else back.
    const commands = control({ streamIngestUrl: TEST_INGEST_URL })
    server.state.streamService = {
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { server: 'rtmps://test-other.invalid/live2' },
    }
    server.freezeStreamService = true

    const error = await commands.setStreamServiceFromVault().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ObsCommandError)
    expect((error as ObsCommandError).reason).toBe('stream_service_not_applied')
    expect((error as Error).message).not.toContain(TEST_STREAM_KEY)
    expect((error as Error).message).toContain('key missing')
  })
})

/**
 * BOARD A-16's remaining half, assigned to T17: what OBS keeps after a run.
 * The stream key lands in the profile's `service.json` and the renderer token
 * lands in the scene-collection JSON, so both are put in at start and taken out
 * at stop, and the vault stays the system of record for both.
 */
describe('ObsControl secret custody on stop (T17, BOARD A-16)', () => {
  const TEST_RENDERER_TOKEN = 'test-renderer-token'

  function commandsWithToken() {
    return control(
      { streamIngestUrl: TEST_INGEST_URL },
      new EnvSecretProvider({
        VL_YOUTUBE_STREAM_KEY: TEST_STREAM_KEY,
        VL_RENDERER_TOKEN: TEST_RENDERER_TOKEN,
      }),
    )
  }

  it('clears the injected stream key so the profile stops holding it', async () => {
    const commands = commandsWithToken()
    await commands.setStreamServiceFromVault()

    const result = await commands.clearStreamServiceKey()

    expect(result.keyConfigured).toBe(false)
    expect(server.state.streamService.streamServiceSettings['key']).toBe('')
    expect(JSON.stringify(result)).not.toContain(TEST_STREAM_KEY)
  })

  it('refuses to clear the key while the output is active', async () => {
    const commands = commandsWithToken()
    server.state.streamStatus.outputActive = true

    const error = await commands.clearStreamServiceKey().catch((caught: unknown) => caught)

    expect((error as ObsCommandError).reason).toBe('stream_active')
    expect(requestTypes()).not.toContain('SetStreamServiceSettings')
  })

  it('injects the renderer token into the Browser Source URL', async () => {
    const result = await commandsWithToken().setRendererSourceFromVault()

    const applied = String(
      server.state.inputs.find((input) => input.inputName === 'test-browser-source')
        ?.inputSettings?.['url'],
    )
    expect(new URL(applied).searchParams.get('token')).toBe(TEST_RENDERER_TOKEN)
    expect(new URL(applied).searchParams.get('mode')).toBe('broadcast')
    // The result is what a caller might log, so it carries no token.
    expect(result).toEqual({
      inputName: 'test-browser-source',
      url: 'http://127.0.0.1:5173/?mode=broadcast',
      tokenConfigured: true,
    })
    expect(JSON.stringify(result)).not.toContain(TEST_RENDERER_TOKEN)
  })

  it('removes the token from the Browser Source URL again', async () => {
    const commands = commandsWithToken()
    await commands.setRendererSourceFromVault()

    const result = await commands.clearRendererSourceToken()

    const applied = String(
      server.state.inputs.find((input) => input.inputName === 'test-browser-source')
        ?.inputSettings?.['url'],
    )
    expect(new URL(applied).searchParams.has('token')).toBe(false)
    expect(result.tokenConfigured).toBe(false)
  })

  it('refuses to inject into an input that is not a Browser Source', async () => {
    const commands = control(
      { browserSourceName: 'test-color-source' },
      new EnvSecretProvider({ VL_RENDERER_TOKEN: TEST_RENDERER_TOKEN }),
    )

    const error = await commands.setRendererSourceFromVault().catch((caught: unknown) => caught)

    expect((error as ObsCommandError).reason).toBe('not_a_browser_source')
  })

  it('refuses to inject when the vault has no renderer token, and names no value', async () => {
    const commands = control({}, new EnvSecretProvider({}))

    const error = await commands.setRendererSourceFromVault().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(MissingSecretError)
    expect((error as Error).message).toContain('server.rendererToken')
    expect((error as Error).message).not.toContain(TEST_RENDERER_TOKEN)
  })
})

describe('ObsControl without a connection', () => {
  it('refuses every command when the client is not connected', async () => {
    const commands = control()
    await client.disconnect()

    await expect(commands.startStream()).rejects.toMatchObject({ name: 'ObsNotConnectedError' })
    await expect(commands.stopStream()).rejects.toMatchObject({ name: 'ObsNotConnectedError' })
    await expect(commands.refreshBrowserSource('test-browser-source')).rejects.toMatchObject({
      name: 'ObsNotConnectedError',
    })
    await expect(commands.switchScene('test-scene-standby')).rejects.toMatchObject({
      name: 'ObsNotConnectedError',
    })
    await expect(commands.setStreamServiceFromVault()).rejects.toMatchObject({
      name: 'ObsNotConnectedError',
    })
  })
})
