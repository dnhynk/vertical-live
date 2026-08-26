import { afterEach, describe, expect, it } from 'vitest'

import type { HealthSignal } from '../../health/types.js'
import { FakeClock, flushMicrotasks } from '../../testing/fake-clock.js'
import type { LiveStreamStatus, YouTubeLiveApi } from './api.js'
import {
  BroadcastHealthMonitor,
  YOUTUBE_BROADCAST_HEALTH_SIGNAL_NAMES,
  YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL,
  YOUTUBE_STREAM_HEALTH_SIGNAL,
  YOUTUBE_STREAM_STATUS_SIGNAL,
  deriveBroadcastHealthSignals,
} from './health.js'
import {
  TEST_BROADCAST_CONFIG,
  createBroadcastHarness,
  type BroadcastHarness,
} from './test-support.js'

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
        lifeCycleSource: 'api',
        lastReconciledAt: null,
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
        lifeCycleSource: 'api',
        lastReconciledAt: null,
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
        lifeCycleSource: 'api',
        lastReconciledAt: null,
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
        lifeCycleSource: 'api',
        lastReconciledAt: null,
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
      {
        streamId: null,
        stream: null,
        broadcastId: null,
        lifeCycleStatus: null,
        lifeCycleSource: 'none',
        lastReconciledAt: null,
      },
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

    const quotaBefore = h.quota.snapshot()
    await monitor.poll()
    const quotaAfter = h.quota.snapshot()

    expect(signals).toHaveLength(3)
    expect(byName(signals, YOUTUBE_STREAM_STATUS_SIGNAL).status).toBe('ok')
    expect(byName(signals, YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL).status).toBe('ok')
    expect(JSON.stringify(signals)).not.toContain(stream?.streamKey)
    expect(
      (quotaAfter.byMethod['liveStreams.list'] ?? 0) -
        (quotaBefore.byMethod['liveStreams.list'] ?? 0),
    ).toBe(1)
    expect(
      (quotaAfter.byMethod['liveBroadcasts.list'] ?? 0) -
        (quotaBefore.byMethod['liveBroadcasts.list'] ?? 0),
    ).toBe(1)
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

  /**
   * The whole point of T44: `liveBroadcasts.list` is read on the reconcile
   * interval, not every poll. At 20s ticks and a 300s reconcile that is one
   * call in fifteen rather than fifteen.
   */
  it('reads the lifecycle on the reconcile interval, not every poll', async () => {
    const clock = new FakeClock()
    harness = await createBroadcastHarness({ clock })
    const h = harness
    const target = await h.lifecycle().ensureLive()
    const stream = h.server.streams.get(target.streamId)
    if (stream !== undefined) {
      stream.streamStatus = 'active'
      stream.healthStatus = 'good'
    }
    const monitor = new BroadcastHealthMonitor({
      api: h.api,
      config: h.config,
      onSignal: () => {},
      resources: () => ({
        streamId: target.streamId,
        broadcastId: target.broadcastId,
        lifeCycleStage: 'live',
      }),
      clock,
    })

    const first = await monitor.poll()
    expect(byName(first, YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL).detail['lifeCycleSource']).toBe('api')

    // A tick inside the reconcile window answers from the stage this process
    // drove the broadcast to, spending nothing.
    await clock.advance(h.config.healthPollIntervalMs)
    const second = await monitor.poll()
    const lifeCycle = byName(second, YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL)
    expect(lifeCycle.detail['lifeCycleSource']).toBe('local')
    expect(lifeCycle.status).toBe('ok')
    expect(lifeCycle.detail['lastReconciledAt']).not.toBeNull()
    // The volatile half is still read every tick.
    expect(byName(second, YOUTUBE_STREAM_STATUS_SIGNAL).status).toBe('ok')

    await clock.advance(h.config.lifecycleReconcileIntervalMs)
    const third = await monitor.poll()
    expect(byName(third, YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL).detail['lifeCycleSource']).toBe('api')
  })

  /**
   * `BroadcastStage` is this product's vocabulary for what it drove; YouTube's
   * `lifeCycleStatus` is a different thing and reconcile exists to compare them.
   * Only `live` crosses over; any other stage says nobody has asked yet.
   */
  it('does not pass a local stage off as a lifecycle YouTube confirmed', async () => {
    const clock = new FakeClock()
    harness = await createBroadcastHarness({ clock })
    const h = harness
    const target = await h.lifecycle().ensureLive()
    const monitor = new BroadcastHealthMonitor({
      api: h.api,
      config: h.config,
      onSignal: () => {},
      resources: () => ({
        streamId: target.streamId,
        broadcastId: target.broadcastId,
        lifeCycleStage: 'bound',
      }),
      clock,
    })

    await monitor.poll()
    await clock.advance(h.config.healthPollIntervalMs)
    const lifeCycle = byName(await monitor.poll(), YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL)

    expect(lifeCycle.status).toBe('unknown')
    expect(lifeCycle.reason).toBe('awaiting_reconcile')
    expect(lifeCycle.detail['lifeCycleStatus']).toBeNull()
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
    // The continuous poll runs on its own interval; statusPollIntervalMs is now
    // only for the bounded waits a transition makes (T44).
    await clock.advance(h.config.healthPollIntervalMs)
    monitor.stop()

    expect(signals.length).toBeGreaterThanOrEqual(3)
    expect(monitor.running).toBe(false)
    expect(clock.pendingTimerCount).toBe(0)
  })

  it('does not make another API call or schedule after an in-flight poll is stopped', async () => {
    const clock = new FakeClock()
    let releaseStream!: (value: unknown) => void
    const streamResult = new Promise<unknown>((resolve) => {
      releaseStream = resolve
    })
    const calls: string[] = []
    const api = {
      listLiveStreamStatuses: () => {
        calls.push('liveStreams.list')
        return streamResult
      },
      listBroadcasts: () => {
        calls.push('liveBroadcasts.list')
        return Promise.resolve({ items: [] })
      },
    } as unknown as YouTubeLiveApi
    const monitor = new BroadcastHealthMonitor({
      api,
      config: TEST_BROADCAST_CONFIG,
      onSignal: () => {},
      resources: () => ({
        streamId: 'synthetic-stream-in-flight',
        broadcastId: 'synthetic-broadcast-in-flight',
      }),
      clock,
    })

    monitor.start()
    await clock.advance(20_000)
    expect(calls).toEqual(['liveStreams.list'])
    expect(clock.pendingTimerCount).toBe(0)

    monitor.stop()
    monitor.stop()
    releaseStream({ items: [{ status: statusOf() }] })
    await flushMicrotasks()
    await clock.advance(120_000)

    expect(monitor.running).toBe(false)
    expect(calls).toEqual(['liveStreams.list'])
    expect(clock.pendingTimerCount).toBe(0)
  })

  it('does not let an old in-flight run add a timer after an explicit restart', async () => {
    const clock = new FakeClock()
    let releaseStream!: (value: unknown) => void
    const streamResult = new Promise<unknown>((resolve) => {
      releaseStream = resolve
    })
    const api = {
      listLiveStreamStatuses: () => streamResult,
      listBroadcasts: () => Promise.resolve({ items: [] }),
    } as unknown as YouTubeLiveApi
    const monitor = new BroadcastHealthMonitor({
      api,
      config: TEST_BROADCAST_CONFIG,
      onSignal: () => {},
      resources: () => ({ streamId: 'synthetic-stream-old-run', broadcastId: null }),
      clock,
    })

    monitor.start()
    await clock.advance(20_000)
    monitor.stop()
    monitor.start()
    expect(clock.pendingTimerCount).toBe(1)

    releaseStream({ items: [{ status: statusOf() }] })
    await flushMicrotasks()
    expect(clock.pendingTimerCount).toBe(1)

    monitor.stop()
    expect(clock.pendingTimerCount).toBe(0)
  })
})
