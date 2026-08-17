import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { YouTubeApiCallError } from './api.js'
import {
  BroadcastLifecycle,
  BroadcastReconcileFailedError,
  BroadcastSafeStopRequiredError,
  BroadcastStreamInactiveError,
} from './lifecycle.js'
import { createBroadcastHarness, type BroadcastHarness } from './test-support.js'

/**
 * `docs/tasks/TASK_SPECS.md` §T10 acceptance 1 and 3, against the fake API server:
 * the normal path, timeout→reconcile, the three channel limits (plus the
 * undocumented daily one), the `invalidAutoStart` fallback, and resuming a
 * half-finished lifecycle after a restart.
 */

let harness: BroadcastHarness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

async function setUp(...args: Parameters<typeof createBroadcastHarness>) {
  harness = await createBroadcastHarness(...args)
  return harness
}

describe('normal path', () => {
  it('creates the stream, creates and binds the broadcast, then transitions to live', async () => {
    const h = await setUp()

    const target = await h.lifecycle().ensureLive()

    expect(target.stage).toBe('live')
    expect(target.adopted).toBe(false)
    expect(target.liveChatId).toMatch(/^synthetic-live-chat-/)
    expect(h.server.requests.map((request) => request.method)).toEqual([
      // Reuse is checked before anything is created.
      'liveStreams.list',
      'liveStreams.insert',
      'liveBroadcasts.insert',
      'liveBroadcasts.bind',
      // `#goLive` reads the lifecycle status once, then testing → live.
      'liveBroadcasts.list',
      'liveBroadcasts.transition',
      'liveBroadcasts.transition',
    ])

    const stored = h.temp.store.getBroadcastAttempt(target.attemptId)
    expect(stored).toMatchObject({
      stage: 'live',
      pendingCall: null,
      streamId: target.streamId,
      broadcastId: target.broadcastId,
      liveChatId: target.liveChatId,
      strategy: 'single',
    })

    const broadcast = h.server.broadcasts.get(target.broadcastId)
    expect(broadcast?.lifeCycleStatus).toBe('live')
    expect(broadcast?.boundStreamId).toBe(target.streamId)
  })

  it('sends the documented required fields and the product defaults', async () => {
    const h = await setUp()

    await h.lifecycle().ensureLive()

    const insert = h.server.requestsFor('liveBroadcasts.insert')[0]
    expect(insert?.query['part']).toBe('id,snippet,contentDetails,status')
    expect(insert?.body).toMatchObject({
      snippet: { title: 'Autonomous Vertical Live' },
      // spec §9.1: first publication stays with the operator.
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
      contentDetails: {
        latencyPreference: 'ultraLow',
        monitorStream: { enableMonitorStream: true },
      },
    })
    const scheduled = (insert?.body as { snippet: { scheduledStartTime: string } }).snippet
      .scheduledStartTime
    expect(Date.parse(scheduled)).toBeGreaterThan(Date.now())

    const streamInsert = h.server.requestsFor('liveStreams.insert')[0]
    expect(streamInsert?.body).toMatchObject({
      snippet: { title: 'vertical-live ingest' },
      // No API field sets 9:16; the portrait canvas is OBS's (see config.ts).
      cdn: { resolution: 'variable', frameRate: 'variable', ingestionType: 'rtmp' },
      contentDetails: { isReusable: true },
    })
    expect(h.server.requests.every((request) => request.authorization?.startsWith('Bearer '))).toBe(
      true,
    )
  })

  it('reuses an existing stream with the configured title instead of creating one', async () => {
    const h = await setUp()
    const existing = h.server.seedStream({ title: h.config.stream.title })

    const target = await h.lifecycle().ensureLive()

    expect(target.streamId).toBe(existing.id)
    expect(h.server.requestsFor('liveStreams.insert')).toHaveLength(0)
    expect(await h.vault.get('youtube.streamKey')).toBe(existing.streamKey)
  })

  it('skips the testing transition when the monitor stream is disabled', async () => {
    const h = await setUp({ config: { enableMonitorStream: false } })

    const target = await h.lifecycle().ensureLive()

    const transitions = h.server
      .requestsFor('liveBroadcasts.transition')
      .map((request) => request.query['broadcastStatus'])
    expect(transitions).toEqual(['live'])
    expect(target.stage).toBe('live')
  })
})

describe('uncertain results are reconciled, never retried blindly', () => {
  it('reconciles a timed-out liveBroadcasts.insert instead of creating a second broadcast', async () => {
    const h = await setUp({ config: { requestTimeoutMs: 60 } })
    // The delayed request is still applied: the broadcast exists, the caller times
    // out before it hears so (spec §9.1).
    h.server.queueDelay('liveBroadcasts.insert', 400)

    const target = await h.lifecycle().ensureLive()

    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
    expect(h.server.broadcasts.size).toBe(1)
    expect(target.broadcastId).toBe([...h.server.broadcasts.keys()][0])
    expect(h.alerts.ofKind('call_reconciled').map((alert) => alert.reason)).toContain('applied')
    expect(target.stage).toBe('live')
  })

  it('reconciles a timed-out liveStreams.insert and still stores the key in the vault', async () => {
    const h = await setUp({ config: { requestTimeoutMs: 60 } })
    h.server.queueDelay('liveStreams.insert', 400)

    const target = await h.lifecycle().ensureLive()

    expect(h.server.requestsFor('liveStreams.insert')).toHaveLength(1)
    expect(h.server.streams.size).toBe(1)
    const created = h.server.streams.get(target.streamId)
    expect(await h.vault.get('youtube.streamKey')).toBe(created?.streamKey)
  })

  it('retries a bind whose 5xx left the outcome unknown, once the reconcile says it did not apply', async () => {
    const h = await setUp()
    h.server.queueFailure('liveBroadcasts.bind', { status: 503, reason: 'serviceUnavailable' })

    const target = await h.lifecycle().ensureLive()

    expect(h.server.requestsFor('liveBroadcasts.bind')).toHaveLength(2)
    expect(h.alerts.ofKind('call_reconciled').map((alert) => alert.reason)).toContain('not_applied')
    expect(target.stage).toBe('live')
  })

  it('gives up with a reconcile error when the outcome never becomes known', async () => {
    const h = await setUp({ maxAttempts: 2 })
    h.server.queueFailure('liveBroadcasts.bind', { status: 503, reason: 'serviceUnavailable' })
    h.server.queueFailure('liveBroadcasts.bind', { status: 503, reason: 'serviceUnavailable' })

    await expect(h.lifecycle().ensureBound()).rejects.toThrow(BroadcastReconcileFailedError)
    expect(h.temp.store.findOpenBroadcastAttempt()?.stage).toBe('broadcast_created')
  })
})

describe('restart', () => {
  it('resumes a half-finished lifecycle from the persisted stage', async () => {
    const h = await setUp()
    const bound = await h.lifecycle().ensureBound()
    expect(bound.stage).toBe('bound')

    const resumed = await h.restart().goLive()

    expect(resumed.attemptId).toBe(bound.attemptId)
    expect(resumed.broadcastId).toBe(bound.broadcastId)
    expect(resumed.streamId).toBe(bound.streamId)
    expect(resumed.stage).toBe('live')
    // Nothing was created twice by the restart.
    expect(h.server.requestsFor('liveStreams.insert')).toHaveLength(1)
    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
    expect(h.server.requestsFor('liveBroadcasts.bind')).toHaveLength(1)
  })

  it('reconciles a call that was in flight when the process died', async () => {
    const h = await setUp()
    const lifecycle = h.lifecycle()
    await lifecycle.ensureBound()
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt).not.toBeNull()

    // Simulate dying between "insert sent" and "result recorded": the broadcast
    // reached `live` at YouTube, the durable row still says a transition is pending.
    const broadcast = h.server.broadcasts.get(attempt?.broadcastId ?? '')
    expect(broadcast).toBeDefined()
    if (broadcast !== undefined) {
      broadcast.lifeCycleStatus = 'live'
    }
    h.temp.store.markBroadcastCallPending(attempt?.attemptId ?? '', 'liveBroadcasts.transition')

    const restarted = h.restart()
    const resumed = await restarted.resume()

    expect(resumed?.pendingCall).toBeNull()
    expect(resumed?.stage).toBe('live')
    expect(h.server.requestsFor('liveBroadcasts.transition')).toHaveLength(0)
  })

  it('adopts a broadcast an interrupted insert had already created', async () => {
    const h = await setUp()
    const first = h.lifecycle()
    // Take the attempt as far as the stream, then fake a crashed insert whose
    // broadcast exists at YouTube under the persisted scheduledStartTime.
    h.server.queueFailure('liveBroadcasts.insert', { status: 503, reason: 'serviceUnavailable' })
    h.server.queueFailure('liveBroadcasts.insert', { status: 503, reason: 'serviceUnavailable' })
    await expect(first.ensureBound()).rejects.toThrow()

    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.broadcastId).toBeNull()
    h.temp.store.markBroadcastCallPending(attempt?.attemptId ?? '', 'liveBroadcasts.insert')
    const landed = h.server.seedBroadcast({
      scheduledStartTime: attempt?.scheduledStartTime ?? '',
      lifeCycleStatus: 'created',
    })

    const resumed = await h.restart().resume()

    expect(resumed?.broadcastId).toBe(landed.id)
    expect(resumed?.stage).toBe('broadcast_created')
    expect(h.server.broadcasts.size).toBe(1)
  })
})

describe('auto-start', () => {
  it('falls back to transition when YouTube answers invalidAutoStart', async () => {
    const h = await setUp({ config: { enableAutoStart: true } })
    h.server.queueFailure('liveBroadcasts.insert', {
      status: 400,
      reason: 'invalidAutoStart',
      message: 'The liveBroadcast resource contained an invalid value for enableAutoStart',
    })

    const target = await h.lifecycle().ensureLive()

    const inserts = h.server.requestsFor('liveBroadcasts.insert')
    expect(inserts).toHaveLength(2)
    expect(
      (inserts[0]?.body as { contentDetails: { enableAutoStart: boolean } }).contentDetails
        .enableAutoStart,
    ).toBe(true)
    expect(
      (inserts[1]?.body as { contentDetails: { enableAutoStart: boolean } }).contentDetails
        .enableAutoStart,
    ).toBe(false)
    expect(h.alerts.ofKind('auto_start_unsupported').map((alert) => alert.reason)).toEqual([
      'invalidAutoStart',
    ])
    expect(target.autoStart).toBe(false)
    expect(target.stage).toBe('live')
    expect(h.server.requestsFor('liveBroadcasts.transition')).toHaveLength(2)
  })

  it('uses no transition when auto-start takes the broadcast live', async () => {
    const h = await setUp({ config: { enableAutoStart: true } })
    const bound = await h.lifecycle().ensureBound()
    const broadcast = h.server.broadcasts.get(bound.broadcastId)
    if (broadcast !== undefined) {
      broadcast.lifeCycleStatus = 'live'
    }

    const target = await h.lifecycle().goLive()

    expect(target.stage).toBe('live')
    expect(h.server.requestsFor('liveBroadcasts.transition')).toHaveLength(0)
  })

  it('transitions anyway when an accepted auto-start never fires', async () => {
    const h = await setUp({ config: { enableAutoStart: true } })

    const target = await h.lifecycle().ensureLive()

    expect(target.stage).toBe('live')
    expect(h.alerts.ofKind('auto_start_unsupported').map((alert) => alert.reason)).toEqual([
      'auto_start_did_not_fire',
    ])
    expect(h.server.requestsFor('liveBroadcasts.transition').length).toBeGreaterThan(0)
  })
})

describe('channel limits', () => {
  it('recovers this product’s existing broadcast on userBroadcastsExceedLimit', async () => {
    const h = await setUp()
    const stream = h.server.seedStream({ title: h.config.stream.title })
    const existing = h.server.seedBroadcast({
      title: h.config.title,
      lifeCycleStatus: 'live',
      boundStreamId: stream.id,
    })
    h.server.queueFailure('liveBroadcasts.insert', {
      status: 403,
      reason: 'userBroadcastsExceedLimit',
    })

    const target = await h.lifecycle().ensureLive()

    expect(target.broadcastId).toBe(existing.id)
    expect(target.adopted).toBe(true)
    expect(target.stage).toBe('live')
    expect(h.alerts.ofKind('broadcast_limit').map((alert) => alert.reason)).toEqual([
      'userBroadcastsExceedLimit',
    ])
    expect(h.alerts.ofKind('broadcast_recovered')).toHaveLength(1)
    expect(h.safeStops).toHaveLength(0)
  })

  it('recovers the live broadcast on concurrentBroadcastsExceedLimit', async () => {
    const h = await setUp()
    const other = h.server.seedBroadcast({
      title: h.config.title,
      lifeCycleStatus: 'live',
    })
    h.server.queueFailure('liveBroadcasts.transition', {
      status: 403,
      reason: 'concurrentBroadcastsExceedLimit',
    })

    const target = await h.lifecycle().ensureLive()

    expect(target.broadcastId).toBe(other.id)
    expect(target.adopted).toBe(true)
    expect(h.alerts.ofKind('broadcast_limit').map((alert) => alert.detail['limit'])).toEqual([
      'concurrent_broadcasts',
    ])
  })

  it('asks for safe_stopped when a limit leaves nothing recoverable', async () => {
    const h = await setUp()
    h.server.queueFailure('liveBroadcasts.insert', {
      status: 403,
      reason: 'userBroadcastsExceedLimit',
    })

    await expect(h.lifecycle().ensureLive()).rejects.toThrow(BroadcastSafeStopRequiredError)

    expect(h.safeStops).toHaveLength(1)
    expect(h.safeStops[0]?.reason).toBe('userBroadcastsExceedLimit')
    expect(h.alerts.ofKind('safe_stop_requested')).toHaveLength(1)
    const attempt = h.temp.store.listBroadcastAttempts()[0]
    expect(attempt?.stage).toBe('abandoned')
    expect(attempt?.closedAt).not.toBeNull()
    expect(h.temp.store.findOpenBroadcastAttempt()).toBeNull()
  })

  it('treats the undocumented daily creation limit as a limit, not a retry', async () => {
    const h = await setUp()
    // YouTube publishes no reason string for the daily creation limit (see
    // limits.ts); this synthetic one only has to be limit-shaped.
    h.server.queueFailure('liveBroadcasts.insert', {
      status: 403,
      reason: 'syntheticDailyBroadcastCreationLimitExceeded',
    })

    await expect(h.lifecycle().ensureLive()).rejects.toThrow(BroadcastSafeStopRequiredError)

    expect(h.alerts.ofKind('broadcast_limit').map((alert) => alert.detail['limit'])).toEqual([
      'daily_creation',
    ])
    // One attempt only: a limit is never retried into a second broadcast.
    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
  })

  it('reuses the ingestion stream when stream creation hits a limit', async () => {
    const h = await setUp()
    h.server.queueFailure('liveStreams.insert', {
      status: 403,
      reason: 'syntheticUserStreamsExceedLimit',
      domain: 'youtube.liveStream',
    })
    // The stream appears while our insert is in flight — the race the recovery path
    // exists for. The first list therefore found nothing, and only the second can.
    h.server.onRequest = (request) => {
      if (request.method === 'liveStreams.insert') {
        h.server.seedStream({ title: h.config.stream.title })
      }
    }

    const target = await h.lifecycle().ensureLive()

    expect(h.server.streams.get(target.streamId)?.title).toBe(h.config.stream.title)
    expect(h.alerts.ofKind('broadcast_recovered')).toHaveLength(1)
    expect(await h.vault.get('youtube.streamKey')).toBe(
      h.server.streams.get(target.streamId)?.streamKey,
    )
  })
})

describe('rejections that need a human or another component', () => {
  it('reports an inactive ingestion stream as its own error', async () => {
    const h = await setUp()
    h.server.streamInactiveOnTransition = true

    await expect(h.lifecycle().ensureLive()).rejects.toThrow(BroadcastStreamInactiveError)

    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.stage).toBe('bound')
    expect(attempt?.lastErrorReason).toBe('errorStreamInactive')
    expect(attempt?.pendingCall).toBeNull()
  })

  it('re-schedules a start time that has fallen into the past', async () => {
    const h = await setUp()
    h.server.queueFailure('liveBroadcasts.insert', {
      status: 400,
      reason: 'invalidScheduledStartTime',
    })

    const target = await h.lifecycle().ensureLive()

    const inserts = h.server.requestsFor('liveBroadcasts.insert')
    expect(inserts).toHaveLength(2)
    const first = (inserts[0]?.body as { snippet: { scheduledStartTime: string } }).snippet
    const second = (inserts[1]?.body as { snippet: { scheduledStartTime: string } }).snippet
    expect(Date.parse(second.scheduledStartTime)).toBeGreaterThanOrEqual(
      Date.parse(first.scheduledStartTime),
    )
    expect(h.temp.store.getBroadcastAttempt(target.attemptId)?.scheduledStartTime).toBe(
      second.scheduledStartTime,
    )
  })

  it('stops without a call when the quota reserve is all that is left', async () => {
    const h = await setUp({ quotaOptions: { dailyUnits: 100, reserveUnits: 60 } })

    const error = await h
      .lifecycle()
      .ensureLive()
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(YouTubeApiCallError)
    expect((error as YouTubeApiCallError).outcome).toBe('not_attempted')
    expect((error as YouTubeApiCallError).classification.kind).toBe('quotaExceeded')
  })

  it('refuses to roll over under the production strategy', async () => {
    const h = await setUp()
    await h.lifecycle().ensureLive()

    await expect(h.lifecycle().rollOver()).rejects.toThrow(/rolling-experiment/)
  })
})

describe('rolling experiment (spec §9.3, labelled)', () => {
  it('completes the current broadcast and brings up a new one with a new liveChatId', async () => {
    const h = await setUp({ config: { strategy: 'rolling-experiment' } })
    const first = await h.lifecycle().ensureLive()

    const second = await h.lifecycle().rollOver()

    expect(second.broadcastId).not.toBe(first.broadcastId)
    expect(second.liveChatId).not.toBe(first.liveChatId)
    expect(h.server.broadcasts.get(first.broadcastId)?.lifeCycleStatus).toBe('complete')
    // The stream is reused across the rollover, so the operator's key does not change.
    expect(second.streamId).toBe(first.streamId)
    const attempts = h.temp.store.listBroadcastAttempts()
    expect(attempts.map((attempt) => attempt.strategy)).toEqual([
      'rolling-experiment',
      'rolling-experiment',
    ])
    expect(attempts[1]?.stage).toBe('complete')
  })
})

describe('the stream key never leaves the vault (acceptance 2)', () => {
  it('is absent from return values, the database file, the logs and the alerts', async () => {
    const h = await setUp()
    const target = await h.lifecycle().ensureLive()
    const streamKey = h.server.streams.get(target.streamId)?.streamKey
    expect(streamKey).toBeDefined()
    expect(await h.vault.get('youtube.streamKey')).toBe(streamKey)

    const key = streamKey as string
    expect(JSON.stringify(target)).not.toContain(key)
    expect(JSON.stringify(h.temp.store.listBroadcastAttempts())).not.toContain(key)
    expect(JSON.stringify(h.alerts.alerts)).not.toContain(key)
    expect(h.logger.dump()).not.toContain(key)
    expect(h.custodian.stagedStreamIds).toEqual([])

    // Every byte the store owns, WAL included.
    h.temp.reopen()
    const onDisk = readdirSync(h.temp.directory)
      .map((name) => readFileSync(join(h.temp.directory, name)).toString('binary'))
      .join('\n')
    expect(onDisk).not.toContain(key)
    expect(onDisk).toContain(target.broadcastId)
  })

  it('stores only the selected stream’s key when the channel has several', async () => {
    const h = await setUp()
    const other = h.server.seedStream({ title: 'someone-else-synthetic-stream' })
    const ours = h.server.seedStream({ title: h.config.stream.title })

    const target = await h.lifecycle().ensureBound()

    expect(target.streamId).toBe(ours.id)
    expect(await h.vault.get('youtube.streamKey')).toBe(ours.streamKey)
    expect(await h.vault.get('youtube.streamKey')).not.toBe(other.streamKey)
  })

  it('masks a stream key that reaches a logger through the shared redactor', async () => {
    const h = await setUp()
    const ours = h.server.seedStream({ title: h.config.stream.title })
    await h.lifecycle().ensureBound()

    expect(h.redactor.redact(`leaked ${ours.streamKey}`)).toBe('leaked [redacted]')
  })
})

describe('guard rails', () => {
  it('refuses goLive() before anything is bound', async () => {
    const h = await setUp()
    const lifecycle: BroadcastLifecycle = h.lifecycle()

    await expect(lifecycle.goLive()).rejects.toThrow(/no open broadcast attempt/)
  })
})
