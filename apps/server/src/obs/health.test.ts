import { afterEach, describe, expect, it } from 'vitest'

import type { HealthSignal } from '../health/types.js'
import { EnvSecretProvider } from '../secrets/index.js'
import { FakeClock } from '../testing/fake-clock.js'
import { FakeObsServer } from '../testing/fake-obs-server.js'
import { TEST_OBS_PASSWORD, testObsConfig, waitFor } from '../testing/obs-test-support.js'
import { ObsClient } from './client.js'
import {
  deriveObsHealthSignals,
  INITIAL_PROGRESS_STATE,
  OBS_CONGESTION_SIGNAL,
  OBS_FRAMES_SIGNAL,
  OBS_OUTPUT_PROGRESS_SIGNAL,
  OBS_STREAM_SIGNAL,
  ObsHealthMonitor,
  type ObsOutputSample,
} from './health.js'
import { EVENT_SUBSCRIPTION, OBS_OUTPUT_STATE } from './protocol.js'

const config = testObsConfig('ws://127.0.0.1:4455')
const thresholds = config.thresholds
const observedAt = { utc: '2026-01-01T00:00:00.000Z', monotonicMs: 0 }

const activeSample: ObsOutputSample = {
  outputActive: true,
  outputReconnecting: false,
  outputDurationMs: 10_000,
  outputCongestion: 0,
  outputBytes: 1_000_000,
  outputSkippedFrames: 0,
  outputTotalFrames: 300,
  renderSkippedFrames: 0,
  renderTotalFrames: 300,
}

function byName(signals: readonly HealthSignal[], name: string): HealthSignal {
  const found = signals.find((signal) => signal.name === name)
  if (found === undefined) {
    throw new Error(`no ${name} signal in [${signals.map((signal) => signal.name).join(', ')}]`)
  }
  return found
}

describe('deriveObsHealthSignals', () => {
  it('reports every signal on each sample', () => {
    const { signals } = deriveObsHealthSignals(
      activeSample,
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    )

    expect(signals.map((signal) => signal.name)).toEqual([
      OBS_STREAM_SIGNAL,
      OBS_OUTPUT_PROGRESS_SIGNAL,
      OBS_FRAMES_SIGNAL,
      OBS_CONGESTION_SIGNAL,
    ])
    for (const signal of signals) {
      expect(signal.component).toBe('obs')
      expect(signal.observedAtUtc).toBe(observedAt.utc)
      expect(signal.observedAtMonotonicMs).toBe(observedAt.monotonicMs)
      if (signal.status !== 'ok') {
        expect(signal.reason).toBeTruthy()
      }
    }
  })

  it('cannot judge progress or frame loss on the first sample', () => {
    const { signals } = deriveObsHealthSignals(
      activeSample,
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    )

    expect(byName(signals, OBS_STREAM_SIGNAL)).toMatchObject({ status: 'ok' })
    expect(byName(signals, OBS_OUTPUT_PROGRESS_SIGNAL)).toMatchObject({
      status: 'unknown',
      reason: 'no_previous_sample',
    })
    expect(byName(signals, OBS_FRAMES_SIGNAL)).toMatchObject({
      status: 'unknown',
      reason: 'no_previous_sample',
    })
  })

  it('reports ok while bytes and duration both increase', () => {
    const first = deriveObsHealthSignals(
      activeSample,
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    )
    const second = deriveObsHealthSignals(
      { ...activeSample, outputBytes: 2_000_000, outputDurationMs: 12_000, outputTotalFrames: 360 },
      first.state,
      thresholds,
      observedAt,
    )

    const progress = byName(second.signals, OBS_OUTPUT_PROGRESS_SIGNAL)
    expect(progress.status).toBe('ok')
    expect(progress.detail).toMatchObject({
      bytesDelta: 1_000_000,
      durationDeltaMs: 2000,
      stalledSamples: 0,
    })
  })

  it('reports degraded once the output stops progressing for stalledSamplesDegradedAt samples', () => {
    let state = deriveObsHealthSignals(
      activeSample,
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    ).state

    const firstStall = deriveObsHealthSignals(activeSample, state, thresholds, observedAt)
    state = firstStall.state
    expect(byName(firstStall.signals, OBS_OUTPUT_PROGRESS_SIGNAL)).toMatchObject({
      status: 'ok',
      detail: { bytesDelta: 0, durationDeltaMs: 0, stalledSamples: 1 },
    })

    const secondStall = deriveObsHealthSignals(activeSample, state, thresholds, observedAt)
    expect(byName(secondStall.signals, OBS_OUTPUT_PROGRESS_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'output_not_progressing',
      detail: { stalledSamples: 2 },
    })
  })

  it('clears the stall counter as soon as the output progresses again', () => {
    let state = deriveObsHealthSignals(
      activeSample,
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    ).state
    state = deriveObsHealthSignals(activeSample, state, thresholds, observedAt).state

    const recovered = deriveObsHealthSignals(
      { ...activeSample, outputBytes: 3_000_000, outputDurationMs: 14_000 },
      state,
      thresholds,
      observedAt,
    )

    expect(byName(recovered.signals, OBS_OUTPUT_PROGRESS_SIGNAL)).toMatchObject({
      status: 'ok',
      detail: { stalledSamples: 0 },
    })
  })

  it('reports an inactive output and stops guessing about its throughput', () => {
    const { signals } = deriveObsHealthSignals(
      { ...activeSample, outputActive: false },
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    )

    expect(byName(signals, OBS_STREAM_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'output_inactive',
    })
    expect(byName(signals, OBS_OUTPUT_PROGRESS_SIGNAL)).toMatchObject({
      status: 'unknown',
      reason: 'output_inactive',
    })
    expect(byName(signals, OBS_CONGESTION_SIGNAL)).toMatchObject({
      status: 'unknown',
      reason: 'output_inactive',
    })
  })

  it('reports a reconnecting output as degraded', () => {
    const { signals } = deriveObsHealthSignals(
      { ...activeSample, outputReconnecting: true },
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    )

    expect(byName(signals, OBS_STREAM_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'output_reconnecting',
    })
  })

  it('reports congestion at or above the threshold', () => {
    const below = deriveObsHealthSignals(
      { ...activeSample, outputCongestion: 0.19 },
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    )
    const atThreshold = deriveObsHealthSignals(
      { ...activeSample, outputCongestion: 0.2 },
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    )

    expect(byName(below.signals, OBS_CONGESTION_SIGNAL).status).toBe('ok')
    expect(byName(atThreshold.signals, OBS_CONGESTION_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'congestion',
      detail: { outputCongestion: 0.2 },
    })
  })

  it('reports skipped frames by ratio over the sample window', () => {
    const state = deriveObsHealthSignals(
      activeSample,
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    ).state

    const { signals } = deriveObsHealthSignals(
      {
        ...activeSample,
        outputBytes: 2_000_000,
        outputDurationMs: 12_000,
        outputTotalFrames: 400,
        outputSkippedFrames: 5,
      },
      state,
      thresholds,
      observedAt,
    )

    expect(byName(signals, OBS_FRAMES_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'skipped_frames',
      detail: { outputSkippedDelta: 5, outputTotalDelta: 100, outputSkippedRatio: 0.05 },
    })
  })

  it('reports render-thread skips as well as output-thread skips', () => {
    const state = deriveObsHealthSignals(
      activeSample,
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    ).state

    const { signals } = deriveObsHealthSignals(
      { ...activeSample, renderTotalFrames: 400, renderSkippedFrames: 20 },
      state,
      thresholds,
      observedAt,
    )

    expect(byName(signals, OBS_FRAMES_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'skipped_frames',
      detail: { renderSkippedDelta: 20, renderTotalDelta: 100, renderSkippedRatio: 0.2 },
    })
  })

  it('treats a restarted output counter as zero, not as a negative delta', () => {
    const state = deriveObsHealthSignals(
      {
        ...activeSample,
        outputSkippedFrames: 900,
        outputTotalFrames: 90_000,
        renderTotalFrames: 90_000,
      },
      INITIAL_PROGRESS_STATE,
      thresholds,
      observedAt,
    ).state

    const { signals } = deriveObsHealthSignals(activeSample, state, thresholds, observedAt)

    expect(byName(signals, OBS_FRAMES_SIGNAL).detail).toMatchObject({
      outputSkippedDelta: 0,
      outputTotalDelta: 0,
      renderTotalDelta: 0,
    })
    expect(byName(signals, OBS_FRAMES_SIGNAL)).toMatchObject({
      status: 'unknown',
      reason: 'no_frames_in_window',
    })
  })
})

describe('ObsHealthMonitor against a fake v5 server', () => {
  let server: FakeObsServer
  let client: ObsClient
  let signals: HealthSignal[]

  async function connect(): Promise<void> {
    server = await FakeObsServer.start({ password: TEST_OBS_PASSWORD })
    signals = []
    client = new ObsClient({
      config: testObsConfig(server.url),
      secrets: new EnvSecretProvider({ VL_OBS_PASSWORD: TEST_OBS_PASSWORD }),
      clock: new FakeClock(),
    })
    await client.connect()
  }

  afterEach(async () => {
    await client.disconnect()
    await server.close()
  })

  it('parses GetStreamStatus and GetStats into signals', async () => {
    await connect()
    server.state.streamStatus = {
      ...server.state.streamStatus,
      outputActive: true,
      outputDuration: 5000,
      outputBytes: 500_000,
      outputCongestion: 0.5,
      outputTotalFrames: 150,
    }
    const monitor = new ObsHealthMonitor({
      source: client,
      config: testObsConfig(server.url),
      onSignal: (signal) => signals.push(signal),
      clock: new FakeClock(),
    })

    await monitor.poll()
    server.state.streamStatus = {
      ...server.state.streamStatus,
      outputDuration: 7000,
      outputBytes: 900_000,
      outputTotalFrames: 210,
    }
    signals = []
    await monitor.poll()

    expect(server.requestLog.map((entry) => entry.requestType)).toContain('GetStreamStatus')
    expect(server.requestLog.map((entry) => entry.requestType)).toContain('GetStats')
    expect(byName(signals, OBS_STREAM_SIGNAL)).toMatchObject({
      status: 'ok',
      detail: { outputActive: true, outputBytes: 900_000, outputDurationMs: 7000 },
    })
    expect(byName(signals, OBS_OUTPUT_PROGRESS_SIGNAL)).toMatchObject({
      status: 'ok',
      detail: { bytesDelta: 400_000, durationDeltaMs: 2000 },
    })
    expect(byName(signals, OBS_CONGESTION_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'congestion',
    })
  })

  it('mirrors a subscribed StreamStateChanged event immediately', async () => {
    await connect()
    const monitor = new ObsHealthMonitor({
      source: client,
      config: testObsConfig(server.url),
      onSignal: (signal) => signals.push(signal),
      clock: new FakeClock(),
    })
    monitor.start()

    server.emitEvent(
      'StreamStateChanged',
      { outputActive: false, outputState: OBS_OUTPUT_STATE.stopped },
      EVENT_SUBSCRIPTION.outputs,
    )
    await waitFor(() => signals.length > 0, 'StreamStateChanged reaches the monitor')
    monitor.stop()

    expect(signals[0]).toMatchObject({
      name: OBS_STREAM_SIGNAL,
      status: 'degraded',
      reason: 'output_inactive',
      detail: {
        outputActive: false,
        outputState: OBS_OUTPUT_STATE.stopped,
        source: 'StreamStateChanged',
      },
    })
  })

  it('reports a reconnecting output from StreamStateChanged as degraded', async () => {
    // Review round 1 finding 5. `StreamStateChanged` has no `outputReconnecting`
    // field, so a retrying output arrives as `outputActive: true` with
    // `OBS_WEBSOCKET_OUTPUT_RECONNECTING`. Reporting that as plain `ok` hides
    // exactly the state spec §9.4(5) requires to be observable.
    await connect()
    const monitor = new ObsHealthMonitor({
      source: client,
      config: testObsConfig(server.url),
      onSignal: (signal) => signals.push(signal),
      clock: new FakeClock(),
    })
    monitor.start()

    server.emitEvent(
      'StreamStateChanged',
      { outputActive: true, outputState: OBS_OUTPUT_STATE.reconnecting },
      EVENT_SUBSCRIPTION.outputs,
    )
    await waitFor(() => signals.length > 0, 'reconnecting event reaches the monitor')

    expect(signals[0]).toMatchObject({
      name: OBS_STREAM_SIGNAL,
      status: 'degraded',
      reason: 'output_reconnecting',
      detail: {
        outputActive: true,
        outputReconnecting: true,
        outputState: OBS_OUTPUT_STATE.reconnecting,
        source: 'StreamStateChanged',
      },
    })

    // Recovery is observable too, and agrees with the polling path's wording.
    signals = []
    server.emitEvent(
      'StreamStateChanged',
      { outputActive: true, outputState: OBS_OUTPUT_STATE.reconnected },
      EVENT_SUBSCRIPTION.outputs,
    )
    await waitFor(() => signals.length > 0, 'reconnected event reaches the monitor')
    monitor.stop()

    expect(signals[0]).toMatchObject({
      name: OBS_STREAM_SIGNAL,
      status: 'ok',
      detail: { outputActive: true, outputReconnecting: false },
    })
    expect(signals[0]?.reason).toBeUndefined()
  })

  it('does not receive events from categories it did not subscribe to', async () => {
    await connect()
    const unsubscribed: string[] = []
    const subscribed: string[] = []
    client.on('InputCreated', () => unsubscribed.push('InputCreated'))
    client.on('StreamStateChanged', () => subscribed.push('StreamStateChanged'))

    // Sent first, on the same socket: if the Inputs category were delivered it
    // would arrive before the Outputs one we then wait for.
    server.emitEvent('InputCreated', { inputName: 'test-input' }, EVENT_SUBSCRIPTION.inputs)
    server.emitEvent(
      'StreamStateChanged',
      { outputActive: true, outputState: OBS_OUTPUT_STATE.started },
      EVENT_SUBSCRIPTION.outputs,
    )
    await waitFor(() => subscribed.length > 0, 'subscribed event arrives')

    expect(unsubscribed).toEqual([])
  })

  it('reports every signal as unknown when OBS cannot be observed', async () => {
    await connect()
    const monitor = new ObsHealthMonitor({
      source: client,
      config: testObsConfig(server.url),
      onSignal: (signal) => signals.push(signal),
      clock: new FakeClock(),
    })
    await client.disconnect()

    await monitor.poll()

    expect(signals).toHaveLength(4)
    for (const signal of signals) {
      expect(signal.status).toBe('unknown')
      expect(signal.reason).toBe('obs_not_connected')
    }
  })

  it('polls on obs.pollIntervalMs while started and stops on stop()', async () => {
    await connect()
    const clock = new FakeClock()
    const monitor = new ObsHealthMonitor({
      source: client,
      config: testObsConfig(server.url, { pollIntervalMs: 2000 }),
      onSignal: (signal) => signals.push(signal),
      clock,
    })

    monitor.start()
    await clock.advance(1999)
    expect(signals).toHaveLength(0)

    await clock.advance(1)
    await waitFor(() => signals.length === 4, 'first scheduled poll')

    await clock.advance(2000)
    await waitFor(() => signals.length === 8, 'second scheduled poll')

    monitor.stop()
    await clock.advance(10_000)
    expect(signals).toHaveLength(8)
    expect(clock.pendingTimerCount).toBe(0)
  })
})
