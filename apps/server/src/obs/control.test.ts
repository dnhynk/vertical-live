import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvSecretProvider } from '../secrets/index.js'
import { FakeClock } from '../testing/fake-clock.js'
import { FakeObsServer } from '../testing/fake-obs-server.js'
import { TEST_OBS_PASSWORD, testObsConfig } from '../testing/obs-test-support.js'
import { ObsClient } from './client.js'
import { ObsCommandError, ObsCommandVerificationError, ObsControl } from './control.js'
import { BROWSER_SOURCE_REFRESH_PROPERTY } from './protocol.js'

let server: FakeObsServer
let client: ObsClient

/** Auto-advancing so the verification loop's sleeps resolve without real time. */
function control(overrides = {}): ObsControl {
  return new ObsControl({
    source: client,
    config: testObsConfig(server.url, overrides),
    clock: new FakeClock({ autoAdvance: true }),
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
  })
})
