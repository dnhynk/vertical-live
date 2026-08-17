import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { systemClock } from '../clock.js'
import type { HealthSignal } from '../health/types.js'
import { EnvSecretProvider } from '../secrets/index.js'
import { ObsClient } from './client.js'
import { loadObsConfig, type ObsConfig } from './config.js'
import { ObsHealthMonitor } from './health.js'
import { BROWSER_SOURCE_INPUT_KIND } from './protocol.js'

/**
 * `npm run obs:probe` — read-only connection smoke test against a running OBS
 * (spec §11 acceptance: the profile and the websocket path are verified on the
 * real host, not asserted). It connects, reads version/video/stream/scene/input
 * state, takes two health samples so the byte and frame deltas are meaningful,
 * and prints what it observed. It changes nothing in OBS: no StartStream, no
 * scene switch, no settings write.
 */

export interface ProbeArgs {
  readonly url: string | undefined
  readonly json: boolean
  readonly fake: boolean
  readonly help: boolean
}

const USAGE = `Usage: npm run obs:probe -- [--url ws://127.0.0.1:4455] [--json] [--fake]

  --url <ws url>  Override obs.url from config/default.json (loopback only).
  --json          Print one JSON document instead of a human-readable report.
  --fake          Probe an in-process fake obs-websocket v5 server instead of
                  OBS. Verifies the probe itself; it is NOT an OBS smoke test.

Reads the obs-websocket password from VL_OBS_PASSWORD (T3 replaces this with the
OS credential vault). The password is never printed.
`

export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  let url: string | undefined
  let json = false
  let fake = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--url': {
        const value = argv[index + 1]
        if (value === undefined || value.startsWith('--')) {
          throw new Error('--url needs a websocket url')
        }
        url = value
        index += 1
        break
      }
      case '--json':
        json = true
        break
      case '--fake':
        fake = true
        break
      case '--help':
      case '-h':
        help = true
        break
      default:
        throw new Error(`unknown argument: ${String(arg)}`)
    }
  }

  return { url, json, fake, help }
}

interface ProbeReport {
  readonly target: string
  readonly connection: {
    readonly url: string
    readonly obsWebSocketVersion: string | undefined
    readonly negotiatedRpcVersion: number | undefined
    readonly reconnectCount: number
  }
  readonly version: Record<string, unknown>
  readonly videoSettings: Record<string, unknown>
  readonly streamStatus: Record<string, unknown>
  readonly currentProgramSceneName: string
  readonly scenes: readonly string[]
  readonly browserSources: readonly string[]
  readonly signals: readonly HealthSignal[]
}

export async function probe(client: ObsClient, config: ObsConfig): Promise<ProbeReport> {
  const monitor = new ObsHealthMonitor({
    source: client,
    config,
    onSignal: () => {},
    clock: systemClock,
  })

  const version = await client.call('GetVersion')
  const videoSettings = await client.call('GetVideoSettings')
  const streamStatus = await client.call('GetStreamStatus')
  const sceneList = await client.call('GetSceneList')
  const inputList = await client.call('GetInputList', { inputKind: BROWSER_SOURCE_INPUT_KIND })

  // Two samples one poll interval apart: byte/duration/frame deltas need a window.
  await monitor.poll()
  await sleep(config.pollIntervalMs)
  const signals = await monitor.poll()

  return {
    target: config.url,
    connection: {
      url: config.url,
      obsWebSocketVersion: client.obsWebSocketVersion,
      negotiatedRpcVersion: client.negotiatedRpcVersion,
      reconnectCount: client.reconnectCount,
    },
    version: { ...version, availableRequests: version.availableRequests.length },
    videoSettings: { ...videoSettings },
    streamStatus: { ...streamStatus },
    currentProgramSceneName: sceneList.currentProgramSceneName,
    scenes: sceneList.scenes.map((scene) => String((scene as { sceneName?: unknown }).sceneName)),
    browserSources: inputList.inputs.map((input) =>
      String((input as { inputName?: unknown }).inputName),
    ),
    signals,
  }
}

export function formatProbeReport(report: ProbeReport): string {
  const lines: string[] = []
  const push = (label: string, value: unknown): void => {
    lines.push(`  ${label.padEnd(26)}${String(value)}`)
  }

  lines.push(`obs-websocket probe — ${report.target}`)
  lines.push('')
  lines.push('connection')
  push('obsWebSocketVersion', report.connection.obsWebSocketVersion)
  push('negotiatedRpcVersion', report.connection.negotiatedRpcVersion)
  push('reconnectCount', report.connection.reconnectCount)

  lines.push('')
  lines.push('GetVersion')
  push('obsVersion', report.version['obsVersion'])
  push('rpcVersion', report.version['rpcVersion'])
  push('platform', report.version['platform'])
  push('platformDescription', report.version['platformDescription'])

  lines.push('')
  lines.push('GetVideoSettings')
  push(
    'base',
    `${String(report.videoSettings['baseWidth'])}x${String(report.videoSettings['baseHeight'])}`,
  )
  push(
    'output',
    `${String(report.videoSettings['outputWidth'])}x${String(report.videoSettings['outputHeight'])}`,
  )
  push(
    'fps',
    `${String(report.videoSettings['fpsNumerator'])}/${String(report.videoSettings['fpsDenominator'])}`,
  )
  push('matches 1080x1920@30', videoMatchesProfile(report.videoSettings) ? 'yes' : 'NO')

  lines.push('')
  lines.push('GetStreamStatus')
  for (const [key, value] of Object.entries(report.streamStatus)) {
    push(key, value)
  }

  lines.push('')
  lines.push('scenes')
  push('current', report.currentProgramSceneName)
  push('all', report.scenes.join(', ') || '(none)')
  push('browser sources', report.browserSources.join(', ') || '(none)')

  lines.push('')
  lines.push('health signals (second sample)')
  for (const signal of report.signals) {
    const reason = signal.reason === undefined ? '' : ` (${signal.reason})`
    lines.push(`  ${signal.name.padEnd(24)}${signal.status}${reason}`)
    lines.push(`  ${' '.repeat(24)}${JSON.stringify(signal.detail)}`)
  }

  return lines.join('\n')
}

/** `ops/obs/` targets a 1080x1920 canvas at 30fps (spec §11 "화면"). */
function videoMatchesProfile(videoSettings: Record<string, unknown>): boolean {
  return (
    videoSettings['baseWidth'] === 1080 &&
    videoSettings['baseHeight'] === 1920 &&
    videoSettings['outputWidth'] === 1080 &&
    videoSettings['outputHeight'] === 1920 &&
    videoSettings['fpsNumerator'] === 30 &&
    videoSettings['fpsDenominator'] === 1
  )
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

async function main(): Promise<number> {
  let args: ProbeArgs
  try {
    args = parseProbeArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  // Imported lazily so a real probe never loads the test double.
  const fakeServer = args.fake
    ? await (
        await import('../testing/fake-obs-server.js')
      ).FakeObsServer.start({
        password: process.env['VL_OBS_PASSWORD'],
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
          // A live output accumulates between reads; without this the probe's
          // two samples would look like a stalled stream.
          streamProgressPerSample: {
            bytes: 2_500_000,
            durationMs: 2000,
            totalFrames: 60,
            skippedFrames: 0,
          },
        },
      })
    : undefined

  const urlOverride = fakeServer?.url ?? args.url
  const config = loadObsConfig(
    urlOverride === undefined ? {} : { env: { ...process.env, VL_OBS_URL: urlOverride } },
  )

  const client = new ObsClient({
    config,
    secrets: new EnvSecretProvider(),
    allowUnauthenticated: fakeServer !== undefined && process.env['VL_OBS_PASSWORD'] === undefined,
  })

  try {
    if (fakeServer !== undefined) {
      process.stdout.write(
        'NOTE: --fake probes an in-process fake obs-websocket v5 server. This verifies the probe,\n' +
          '      not OBS. A real OBS smoke test needs a running OBS with its WebSocket server on.\n\n',
      )
    }
    await client.connect()
    const report = await probe(client, config)
    process.stdout.write(
      args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatProbeReport(report)}\n`,
    )
    return 0
  } catch (error) {
    process.stderr.write(`obs probe failed: ${(error as Error).message}\n`)
    return 1
  } finally {
    await client.disconnect()
    await fakeServer?.close()
  }
}

/** True only when this file is the process entry point, not when imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) {
    return false
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  process.exitCode = await main()
}
