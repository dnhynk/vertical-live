import { afterEach, describe, expect, it } from 'vitest'

import type { HealthSignal } from '../../health/types.js'
import { FakeClock } from '../../testing/fake-clock.js'
import type { LiveStreamStatus } from './api.js'
import {
  BroadcastHealthMonitor,
  YOUTUBE_BROADCAST_HEALTH_SIGNAL_NAMES,
  YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL,
  YOUTUBE_STREAM_HEALTH_SIGNAL,
  YOUTUBE_STREAM_STATUS_SIGNAL,
  deriveBroadcastHealthSignals,
} from './health.js'
import { createBroadcastHarness, type BroadcastHarness } from './test-support.js'

/** spec §9.4(6): report `liveStreams.status` and the broadcast lifecycle, decide nothing. */

const OBSERVED_AT = { utc: '2026-01-01T00:00:00.000Z', monotonicMs: 1_000 }

function statusOf(overrides: Partial<LiveStreamStatus> = {}): LiveStreamStatus {
  return {
    streamStatus: 'active',
    healthStatus: 'good',
    lastUpdateTimeSeconds: 1_767_225_600,
    configurationIssues: [],
    ...overrides,
  }
}

function byName(signals: readonly HealthSignal[], name: string): HealthSignal {
  const found = signals.find((signal) => signal.name === name)
  if (found === undefined) {
    throw new Error(`no signal named ${name}`)
  }
  return found
}

describe('derived signals', () => {
  it('reports a healthy active stream and a live broadcast as ok', () => {
    const signals = deriveBroadcastHealthSignals(
      {
        streamId: 'synthetic-stream-1',
        stream: statusOf(),
        broadcastId: 'synthetic-broadcast-1',
        lifeCycleStatus: 'live',
      },
      OBSERVED_AT,
    )

    expect(signals.map((signal) => signal.name)).toEqual([...YOUTUBE_BROADCAST_HEALTH_SIGNAL_NAMES])
    expect(signals.every((signal) => signal.component === 'youtube')).toBe(true)
    expect(signals.every((signal) => signal.status === 'ok')).toBe(true)
    expect(signals.every((signal) => signal.observedAtUtc === OBSERVED_AT.utc)).toBe(true)
  })

  it('reports an inactive stream as degraded and no-data health as unknown', () => {
    const signals = deriveBroadcastHealthSignals(
      {
        streamId: 'synthetic-stream-1',
        stream: statusOf({ streamStatus: 'inactive', healthStatus: 'noData' }),
        broadcastId: 'synthetic-broadcast-1',
        lifeCycleStatus: 'ready',
      },
      OBSERVED_AT,
    )

    expect(byName(signals, YOUTUBE_STREAM_STATUS_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'stream_inactive',
    })
    // Nobody pushing is not a fault: `noData` is unobserved, not bad.
    expect(byName(signals, YOUTUBE_STREAM_HEALTH_SIGNAL)).toMatchObject({
      status: 'unknown',
      reason: 'health_no_data',
    })
    expect(byName(signals, YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'lifecycle_ready',
    })
  })

  it('reports bad health and error-severity configuration issues as degraded', () => {
    const bad = deriveBroadcastHealthSignals(
      {
        streamId: 'synthetic-stream-1',
        stream: statusOf({ healthStatus: 'bad' }),
        broadcastId: null,
        lifeCycleStatus: null,
      },
      OBSERVED_AT,
    )
    expect(byName(bad, YOUTUBE_STREAM_HEALTH_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'health_bad',
    })

    const issues = deriveBroadcastHealthSignals(
      {
        streamId: 'synthetic-stream-1',
        stream: statusOf({
          healthStatus: 'ok',
          configurationIssues: [
            { type: 'videoBitrateLow', severity: 'warning', reason: null, description: null },
            { type: 'noAudioStream', severity: 'error', reason: null, description: null },
          ],
        }),
        broadcastId: null,
        lifeCycleStatus: null,
      },
      OBSERVED_AT,
    )
    const signal = byName(issues, YOUTUBE_STREAM_HEALTH_SIGNAL)
    expect(signal).toMatchObject({ status: 'degraded', reason: 'configuration_issue_error' })
    expect(signal.detail['worstSeverity']).toBe('error')
    expect(signal.detail['configurationIssueCount']).toBe(2)
    expect(signal.detail['issueTypes']).toBe('videoBitrateLow,noAudioStream')
  })

  it('reports unknown, with a reason, when there is nothing to observe yet', () => {
    const signals = deriveBroadcastHealthSignals(
      { streamId: null, stream: null, broadcastId: null, lifeCycleStatus: null },
      OBSERVED_AT,
    )

    expect(signals.every((signal) => signal.status === 'unknown')).toBe(true)
    expect(byName(signals, YOUTUBE_STREAM_STATUS_SIGNAL).reason).toBe('no_stream_yet')
    expect(byName(signals, YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL).reason).toBe('no_broadcast_yet')
  })
})

describe('monitor', () => {
  let harness: BroadcastHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('polls the live resources and never leaks the stream key into a signal', async () => {
    const clock = new FakeClock()
    harness = await createBroadcastHarness({ clock })
    const h = harness
    const target = await h.lifecycle().ensureLive()
    const stream = h.server.streams.get(target.streamId)
    if (stream !== undefined) {
      stream.streamStatus = 'active'
      stream.healthStatus = 'good'
    }
    const signals: HealthSignal[] = []
    const monitor = new BroadcastHealthMonitor({
      api: h.api,
      config: h.config,
      onSignal: (signal) => signals.push(signal),
      resources: () => ({ streamId: target.streamId, broadcastId: target.broadcastId }),
      clock,
    })

    await monitor.poll()

    expect(signals).toHaveLength(3)
    expect(byName(signals, YOUTUBE_STREAM_STATUS_SIGNAL).status).toBe('ok')
    expect(byName(signals, YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL).status).toBe('ok')
    expect(JSON.stringify(signals)).not.toContain(stream?.streamKey)
  })

  it('reports unknown instead of throwing when the API call fails', async () => {
    const clock = new FakeClock()
    harness = await createBroadcastHarness({ clock })
    const h = harness
    const stream = h.server.seedStream({ title: h.config.stream.title })
    const broadcast = h.server.seedBroadcast()
    h.server.queueFailure('liveStreams.list', { status: 503, reason: 'serviceUnavailable' })
    h.server.queueFailure('liveBroadcasts.list', { status: 503, reason: 'serviceUnavailable' })
    const monitor = new BroadcastHealthMonitor({
      api: h.api,
      config: h.config,
      onSignal: () => {},
      resources: () => ({ streamId: stream.id, broadcastId: broadcast.id }),
      clock,
    })

    const signals = await monitor.poll()

    expect(signals.map((signal) => signal.status)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(byName(signals, YOUTUBE_STREAM_STATUS_SIGNAL).reason).toBe('status_unreadable')
    expect(byName(signals, YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL).reason).toBe('lifecycle_unreadable')
  })

  it('starts and stops on the injected clock', async () => {
    const clock = new FakeClock()
    harness = await createBroadcastHarness({ clock })
    const h = harness
    const signals: HealthSignal[] = []
    const monitor = new BroadcastHealthMonitor({
      api: h.api,
      config: h.config,
      onSignal: (signal) => signals.push(signal),
      resources: () => ({ streamId: null, broadcastId: null }),
      clock,
    })

    monitor.start()
    expect(monitor.running).toBe(true)
    await clock.advance(h.config.statusPollIntervalMs)
    monitor.stop()

    expect(signals.length).toBeGreaterThanOrEqual(3)
    expect(monitor.running).toBe(false)
    expect(clock.pendingTimerCount).toBe(0)
  })
})
