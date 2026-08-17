import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EnvSecretProvider } from '../secrets/index.js'
import { FakeClock } from '../testing/fake-clock.js'
import { FakeObsServer } from '../testing/fake-obs-server.js'
import { TEST_OBS_PASSWORD, testObsConfig } from '../testing/obs-test-support.js'
import { ObsClient } from './client.js'
import { formatProbeReport, parseProbeArgs, probe } from './probe.js'

describe('parseProbeArgs', () => {
  it('defaults to the configured url and human-readable output', () => {
    expect(parseProbeArgs([])).toEqual({ url: undefined, json: false, fake: false, help: false })
  })

  it('reads --url, --json, --fake and --help', () => {
    expect(parseProbeArgs(['--url', 'ws://127.0.0.1:4499', '--json', '--fake'])).toEqual({
      url: 'ws://127.0.0.1:4499',
      json: true,
      fake: true,
      help: false,
    })
    expect(parseProbeArgs(['-h']).help).toBe(true)
  })

  it('rejects --url without a value', () => {
    expect(() => parseProbeArgs(['--url'])).toThrow(/--url needs a websocket url/)
    expect(() => parseProbeArgs(['--url', '--json'])).toThrow(/--url needs a websocket url/)
  })

  it('rejects an unknown argument instead of ignoring it', () => {
    expect(() => parseProbeArgs(['--stream'])).toThrow(/unknown argument: --stream/)
  })
})

describe('probe against a fake v5 server', () => {
  let server: FakeObsServer
  let client: ObsClient

  beforeEach(async () => {
    server = await FakeObsServer.start({
      password: TEST_OBS_PASSWORD,
      state: {
        streamStatus: {
          outputActive: true,
          outputReconnecting: false,
          outputTimecode: '00:00:30.000',
          outputDuration: 30_000,
          outputCongestion: 0.02,
          outputBytes: 37_500_000,
          outputSkippedFrames: 1,
          outputTotalFrames: 900,
        },
        streamProgressPerSample: {
          bytes: 2_500_000,
          durationMs: 2000,
          totalFrames: 60,
          skippedFrames: 0,
        },
      },
    })
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

  it('reads version, video, stream, scene and browser-source state', async () => {
    const report = await probe(client, testObsConfig(server.url, { pollIntervalMs: 1 }))

    expect(report.connection).toMatchObject({
      obsWebSocketVersion: '5.6.3',
      negotiatedRpcVersion: 1,
    })
    expect(report.version).toMatchObject({ obsVersion: '32.0.2', rpcVersion: 1 })
    expect(report.videoSettings).toMatchObject({ baseWidth: 1080, baseHeight: 1920 })
    expect(report.scenes).toEqual(['test-scene-live', 'test-scene-standby'])
    expect(report.currentProgramSceneName).toBe('test-scene-live')
    // GetInputList was filtered to browser sources, so the colour source is out.
    expect(report.browserSources).toEqual(['test-browser-source'])
  })

  it('takes two samples so byte and frame deltas are real', async () => {
    const report = await probe(client, testObsConfig(server.url, { pollIntervalMs: 1 }))

    const progress = report.signals.find((signal) => signal.name === 'obs.output_progress')
    expect(progress).toMatchObject({
      status: 'ok',
      detail: { bytesDelta: 2_500_000, durationDeltaMs: 2000 },
    })
  })

  it('renders a report that flags a canvas which is not 1080x1920@30', async () => {
    server.state.videoSettings = { ...server.state.videoSettings, baseHeight: 1080 }

    const text = formatProbeReport(
      await probe(client, testObsConfig(server.url, { pollIntervalMs: 1 })),
    )

    expect(text).toContain('matches 1080x1920@30      NO')
    expect(text).toContain('obs.stream')
    expect(text).not.toContain(TEST_OBS_PASSWORD)
  })

  it('fails rather than reporting state when OBS is unreachable', async () => {
    await client.disconnect()

    await expect(probe(client, testObsConfig(server.url))).rejects.toMatchObject({
      name: 'ObsNotConnectedError',
    })
  })
})
