import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeClock } from '../../testing/fake-clock.js'
import { METHOD_ALLOWED_PARTS, YouTubeApiCallError } from './api.js'
import {
  BroadcastLifecycle,
  BroadcastMarkerNotClearedError,
  BroadcastReconcileFailedError,
  BroadcastReconcileInconclusiveError,
  BroadcastSafeStopRequiredError,
  BroadcastStreamInactiveError,
} from './lifecycle.js'
import { BroadcastHealthMonitor } from './health.js'
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

/**
 * Runs `work` with one call of `method` applied at YouTube but never answered, and
 * the client's timeout fired from the injected clock (review round 1, M2). Nothing
 * here depends on wall-clock ordering: the server states that it applied the request
 * before the abort is triggered.
 */
async function withAppliedButUnknown<T>(
  h: BroadcastHarness,
  clock: FakeClock,
  method: Parameters<BroadcastHarness['server']['holdApplied']>[0],
  work: () => Promise<T>,
): Promise<T> {
  const hold = h.server.holdApplied(method)
  const running = work()
  await hold.applied
  await clock.advance(h.config.requestTimeoutMs)
  hold.release()
  return running
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
      // The broadcast id is durable now, so the attempt marker is read back and
      // removed from the description before anything else happens (BOARD A-18).
      'liveBroadcasts.list',
      'liveBroadcasts.update',
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
    // The attempt marker travels in the description, and it is the persisted one
    // (review round 2, B1).
    const attempt = h.temp.store.listBroadcastAttempts()[0]
    expect(attempt?.attemptMarker).toBe(`vl-attempt:${String(attempt?.attemptId)}`)
    expect((insert?.body as { snippet: { description: string } }).snippet.description).toBe(
      attempt?.attemptMarker,
    )

    const streamInsert = h.server.requestsFor('liveStreams.insert')[0]
    // The stream carries the same attempt identity as the broadcast (review round 5, B1).
    expect((streamInsert?.body as { snippet: { description: string } }).snippet.description).toBe(
      h.temp.store.listBroadcastAttempts()[0]?.attemptMarker,
    )
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
    const clock = new FakeClock()
    const h = await setUp({ clock })
    // The held request is applied and then left unanswered: the broadcast exists, the
    // caller times out before it hears so (spec §9.1).
    const lifecycle = h.lifecycle()

    const target = await withAppliedButUnknown(h, clock, 'liveBroadcasts.insert', () =>
      lifecycle.ensureLive(),
    )

    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
    expect(h.server.broadcasts.size).toBe(1)
    expect(target.broadcastId).toBe([...h.server.broadcasts.keys()][0])
    expect(h.alerts.ofKind('call_reconciled').map((alert) => alert.reason)).toContain('applied')
    expect(target.stage).toBe('live')
  })

  it('reconciles a timed-out liveStreams.insert and still stores the key in the vault', async () => {
    const clock = new FakeClock()
    const h = await setUp({ clock })
    const lifecycle = h.lifecycle()

    const target = await withAppliedButUnknown(h, clock, 'liveStreams.insert', () =>
      lifecycle.ensureLive(),
    )

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

  it('never retries an insert when the reconcile list was truncated', async () => {
    // Review round 1 (B2) reproduction: with more upcoming broadcasts than the page
    // bound covers, "absent from the list" used to clear the pending call and
    // authorize a second insert — two broadcasts for one attempt.
    const clock = new FakeClock()
    const h = await setUp({ clock })
    for (let index = 0; index < 200; index += 1) {
      h.server.seedBroadcast({
        title: `synthetic-unrelated-broadcast-${String(index)}`,
        lifeCycleStatus: 'ready',
        scheduledStartTime: `2026-01-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      })
    }
    const lifecycle = h.lifecycle()

    const error = await withAppliedButUnknown(h, clock, 'liveBroadcasts.insert', () =>
      lifecycle.ensureBound().catch((caught: unknown) => caught),
    )

    expect(error).toBeInstanceOf(BroadcastReconcileInconclusiveError)
    expect((error as BroadcastReconcileInconclusiveError).detail).toBe('broadcast_list_truncated')
    // Exactly one insert, and exactly one broadcast carrying this attempt's key.
    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    const sameKey = [...h.server.broadcasts.values()].filter((broadcast) =>
      (broadcast.description ?? '').includes(attempt?.attemptMarker ?? 'no-marker'),
    )
    expect(sameKey).toHaveLength(1)
    // The uncertainty is still on the row, so the next resume asks again.
    expect(attempt?.pendingCall).toBe('liveBroadcasts.insert')
    expect(attempt?.lastErrorReason).toBe('reconcile_inconclusive:broadcast_list_truncated')
    expect(h.logger.dump()).toContain('list truncated at the page bound')
  })

  it('never adopts an unrelated broadcast that merely shares the scheduled time', async () => {
    // Review round 2 (B1) reproduction. The decoy is scheduled for the attempt's exact
    // instant and listed first; the insert that actually landed is the one carrying
    // this attempt's marker. Matching on the time alone bound the decoy and orphaned
    // the real resource.
    const clock = new FakeClock()
    const h = await setUp({ clock })
    const lifecycle = h.lifecycle()
    // The attempt's scheduled time is now + lead, and the FakeClock does not move.
    const scheduledStartTime = new Date(
      Date.parse(clock.nowUtcIso()) + h.config.scheduledStartLeadMs,
    ).toISOString()
    const decoy = h.server.seedBroadcast({
      title: 'synthetic-unrelated-same-time',
      lifeCycleStatus: 'ready',
      scheduledStartTime,
    })
    let inserted: { id: string } | undefined
    h.server.onRequest = (request) => {
      if (request.method === 'liveBroadcasts.insert') {
        // Recorded here because the marker is removed once the id is adopted, so the
        // description can no longer be used to point at it afterwards.
        queueMicrotask(() => {
          inserted = [...h.server.broadcasts.values()].find(
            (broadcast) => broadcast.id !== decoy.id,
          )
        })
      }
    }

    const target = await withAppliedButUnknown(h, clock, 'liveBroadcasts.insert', () =>
      lifecycle.ensureLive(),
    )

    const attempt = h.temp.store.getBroadcastAttempt(target.attemptId)
    expect(attempt?.scheduledStartTime).toBe(scheduledStartTime)
    // Two broadcasts share the instant; only one carries the marker.
    const sameTime = [...h.server.broadcasts.values()].filter(
      (broadcast) => broadcast.scheduledStartTime === scheduledStartTime,
    )
    expect(sameTime).toHaveLength(2)
    expect(target.broadcastId).not.toBe(decoy.id)
    // It adopted the broadcast its own insert created — the one that carried the
    // marker — and then took the marker back out again (BOARD A-18).
    expect(target.broadcastId).toBe(inserted?.id)
    expect(h.server.broadcasts.get(target.broadcastId)?.description ?? '').not.toContain(
      attempt?.attemptMarker,
    )
    expect(attempt?.markerClearedAt).not.toBeNull()
    // Still exactly one insert, and the decoy was left alone.
    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
    expect(h.server.broadcasts.get(decoy.id)?.boundStreamId).toBeNull()
    expect(h.server.broadcasts.get(decoy.id)?.lifeCycleStatus).toBe('ready')
  })

  it('does not adopt a same-time broadcast when the insert never landed', async () => {
    const h = await setUp({ maxAttempts: 1 })
    const lifecycle = h.lifecycle()
    // Reject the insert outright (nothing created), with a decoy already sitting at
    // the time this attempt will ask for.
    h.server.queueFailure('liveBroadcasts.insert', { status: 503, reason: 'serviceUnavailable' })
    h.server.onRequest = (request) => {
      if (request.method === 'liveBroadcasts.insert') {
        const snippet = (request.body as { snippet: { scheduledStartTime: string } }).snippet
        h.server.seedBroadcast({
          title: 'synthetic-unrelated-same-time',
          lifeCycleStatus: 'ready',
          scheduledStartTime: snippet.scheduledStartTime,
        })
      }
    }

    await expect(lifecycle.ensureBound()).rejects.toThrow(BroadcastReconcileFailedError)

    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.broadcastId).toBeNull()
    expect(attempt?.lastErrorReason).toBe('reconciled_not_applied')
  })

  it('adopts the stream its own insert created, not a same-title one beside it', async () => {
    // Review round 5 (B1) reproduction. The reuse scan finds nothing; a same-title decoy
    // appears while the insert is in flight; the insert is applied and left unanswered.
    // Title matching adopted the decoy and vaulted its key — the value OBS acts on —
    // while the stream the insert created was orphaned.
    const clock = new FakeClock()
    const h = await setUp({ clock })
    const lifecycle = h.lifecycle()
    let decoy: { id: string; streamKey: string } | undefined
    h.server.onRequest = (request) => {
      if (request.method === 'liveStreams.insert' && decoy === undefined) {
        decoy = h.server.seedStream({ title: h.config.stream.title })
      }
    }

    const target = await withAppliedButUnknown(h, clock, 'liveStreams.insert', () =>
      lifecycle.ensureBound(),
    )

    // Two same-title streams exist; only one carries this attempt's marker.
    const sameTitle = [...h.server.streams.values()].filter(
      (stream) => stream.title === h.config.stream.title,
    )
    expect(sameTitle).toHaveLength(2)
    const attempt = h.temp.store.getBroadcastAttempt(target.attemptId)
    expect(target.streamId).not.toBe(decoy?.id)
    expect(h.server.streams.get(target.streamId)?.description).toContain(attempt?.attemptMarker)
    // The vault carries the adopted stream's key, not the decoy's.
    expect(await h.vault.get('youtube.streamKey')).toBe(
      h.server.streams.get(target.streamId)?.streamKey,
    )
    expect(await h.vault.get('youtube.streamKey')).not.toBe(decoy?.streamKey)
    expect(h.server.requestsFor('liveStreams.insert')).toHaveLength(1)
    expect(attempt?.pendingCall).toBeNull()
  })

  it('stays inconclusive when two streams carry the same attempt marker', async () => {
    const h = await setUp({ maxAttempts: 1 })
    const lifecycle = h.lifecycle()
    h.server.queueFailure('liveStreams.insert', { status: 503, reason: 'serviceUnavailable' })
    // Two inserts landed for one attempt: adopting either orphans the other, and either
    // key could be the wrong one to vault.
    h.server.onRequest = (request) => {
      if (request.method === 'liveStreams.insert') {
        const body = request.body as { snippet: { title: string; description: string } }
        for (const index of [1, 2]) {
          h.server.seedStream({
            title: body.snippet.title,
            description: body.snippet.description,
            streamKey: `synthetic-duplicate-key-${String(index)}`,
          })
        }
      }
    }

    const error = await lifecycle.ensureBound().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BroadcastReconcileInconclusiveError)
    expect((error as BroadcastReconcileInconclusiveError).detail).toBe('stream_marker_ambiguous')
    expect(await h.vault.get('youtube.streamKey')).toBeUndefined()
    expect(h.custodian.stagedStreamIds).toEqual([])
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.pendingCall).toBe('liveStreams.insert')
    expect(attempt?.streamId).toBeNull()
  })

  it('stays inconclusive when the marker turns up on a stream with another title', async () => {
    const h = await setUp({ maxAttempts: 1 })
    const lifecycle = h.lifecycle()
    h.server.queueFailure('liveStreams.insert', { status: 503, reason: 'serviceUnavailable' })
    h.server.onRequest = (request) => {
      if (request.method === 'liveStreams.insert') {
        const body = request.body as { snippet: { description: string } }
        h.server.seedStream({
          title: 'synthetic-some-other-title',
          description: body.snippet.description,
        })
      }
    }

    const error = await lifecycle.ensureBound().catch((caught: unknown) => caught)

    expect((error as BroadcastReconcileInconclusiveError).detail).toBe(
      'stream_marker_title_mismatch',
    )
    expect(await h.vault.get('youtube.streamKey')).toBeUndefined()
    expect(h.temp.store.findOpenBroadcastAttempt()?.pendingCall).toBe('liveStreams.insert')
  })

  it('writes nothing to the vault when a truncated stream scan cannot decide', async () => {
    // Review round 4 (B1) reproduction. A same-title decoy is visible on the first page
    // and the stream this attempt's insert actually created sits past the page bound.
    // The DB already refused to decide; the vault must refuse too, because the key it
    // holds is the one OBS treats as authoritative.
    const h = await setUp()
    const decoy = h.server.seedStream({ title: h.config.stream.title })
    for (let index = 0; index < 200; index += 1) {
      h.server.seedStream({ title: `synthetic-unrelated-stream-${String(index)}` })
    }
    const landed = h.server.seedStream({ title: h.config.stream.title })
    // The durable state of a process that died with the insert in flight.
    const attempt = h.temp.store.beginBroadcastAttempt({
      attemptId: 'attempt-resumed',
      strategy: 'single',
      streamTitle: h.config.stream.title,
      scheduledStartTime: '2026-01-01T00:02:00.000Z',
      attemptMarker: 'vl-attempt:attempt-resumed',
    })
    h.temp.store.markBroadcastCallPending(attempt.attemptId, 'liveStreams.insert')

    const error = await h
      .lifecycle()
      .resume()
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BroadcastReconcileInconclusiveError)
    expect((error as BroadcastReconcileInconclusiveError).detail).toBe('stream_list_truncated')
    // Neither key was adopted — not the visible decoy's, not the real one's.
    expect(await h.vault.get('youtube.streamKey')).toBeUndefined()
    expect(await h.vault.get('youtube.streamKey')).not.toBe(decoy.streamKey)
    expect(await h.vault.get('youtube.streamKey')).not.toBe(landed.streamKey)
    expect(h.custodian.stagedStreamIds).toEqual([])
    const resumed = h.temp.store.getBroadcastAttempt(attempt.attemptId)
    expect(resumed?.pendingCall).toBe('liveStreams.insert')
    expect(resumed?.streamId).toBeNull()
    expect(resumed?.lastErrorReason).toBe('reconcile_inconclusive:stream_list_truncated')
    expect(h.logger.dump()).toContain('list truncated at the page bound')
  })

  it('refuses to adopt a visible marker match while the list is truncated', async () => {
    // Review round 3 (B1) reproduction. A marker is visible on the first page, 200
    // unrelated broadcasts follow, and the copy this attempt's insert actually created
    // sits past the page bound. `markerMatches` is only a lower bound here, so one
    // visible match proves nothing — the old build adopted the first-page decoy and
    // orphaned the real resource.
    const clock = new FakeClock()
    const h = await setUp({ clock })
    const lifecycle = h.lifecycle()
    const scheduledStartTime = new Date(
      Date.parse(clock.nowUtcIso()) + h.config.scheduledStartLeadMs,
    ).toISOString()
    // The marker is derived from the attempt id, which the harness makes deterministic.
    const decoy = h.server.seedBroadcast({
      title: 'synthetic-first-page-decoy',
      lifeCycleStatus: 'ready',
      scheduledStartTime,
      description: 'vl-attempt:attempt-0001',
    })
    for (let index = 0; index < 200; index += 1) {
      h.server.seedBroadcast({
        title: `synthetic-unrelated-broadcast-${String(index)}`,
        lifeCycleStatus: 'ready',
        scheduledStartTime: `2026-01-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      })
    }

    const error = await withAppliedButUnknown(h, clock, 'liveBroadcasts.insert', () =>
      lifecycle.ensureBound().catch((caught: unknown) => caught),
    )

    expect(error).toBeInstanceOf(BroadcastReconcileInconclusiveError)
    expect((error as BroadcastReconcileInconclusiveError).detail).toBe('broadcast_list_truncated')
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.attemptMarker).toBe('vl-attempt:attempt-0001')
    // Nothing was adopted — least of all the decoy — and nothing was retried.
    expect(attempt?.broadcastId).toBeNull()
    expect(attempt?.pendingCall).toBe('liveBroadcasts.insert')
    expect(attempt?.lastErrorReason).toBe('reconcile_inconclusive:broadcast_list_truncated')
    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
    expect(h.server.broadcasts.get(decoy.id)?.boundStreamId).toBeNull()
    // Two broadcasts carry the marker, which is precisely why no verdict was reachable.
    const marked = [...h.server.broadcasts.values()].filter((broadcast) =>
      (broadcast.description ?? '').includes('vl-attempt:attempt-0001'),
    )
    expect(marked).toHaveLength(2)
    expect(h.logger.dump()).toContain('list truncated at the page bound')
  })

  it('stays inconclusive when two broadcasts carry the same attempt marker', async () => {
    const h = await setUp({ maxAttempts: 1 })
    const lifecycle = h.lifecycle()
    h.server.queueFailure('liveBroadcasts.insert', { status: 503, reason: 'serviceUnavailable' })
    // Two inserts landed for one attempt (a duplicate this very rule exists to stop).
    // Adopting either would orphan the other, so the row must stay pending.
    h.server.onRequest = (request) => {
      if (request.method === 'liveBroadcasts.insert') {
        const body = request.body as {
          snippet: { scheduledStartTime: string; description: string }
        }
        for (const index of [1, 2]) {
          h.server.seedBroadcast({
            title: `synthetic-duplicate-${String(index)}`,
            lifeCycleStatus: 'ready',
            scheduledStartTime: body.snippet.scheduledStartTime,
            description: body.snippet.description,
          })
        }
      }
    }

    const error = await lifecycle.ensureBound().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BroadcastReconcileInconclusiveError)
    expect((error as BroadcastReconcileInconclusiveError).detail).toBe('marker_ambiguous')
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.pendingCall).toBe('liveBroadcasts.insert')
    expect(attempt?.broadcastId).toBeNull()
    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
  })

  it('stays inconclusive when the marker matches but the scheduled time does not', async () => {
    const h = await setUp({ maxAttempts: 1 })
    const lifecycle = h.lifecycle()
    h.server.queueFailure('liveBroadcasts.insert', { status: 503, reason: 'serviceUnavailable' })
    h.server.onRequest = (request) => {
      if (request.method === 'liveBroadcasts.insert') {
        const body = request.body as { snippet: { description: string } }
        h.server.seedBroadcast({
          lifeCycleStatus: 'ready',
          scheduledStartTime: '2029-12-31T23:59:00.000Z',
          description: body.snippet.description,
        })
      }
    }

    const error = await lifecycle.ensureBound().catch((caught: unknown) => caught)

    expect((error as BroadcastReconcileInconclusiveError).detail).toBe('marker_time_mismatch')
    expect(h.temp.store.findOpenBroadcastAttempt()?.pendingCall).toBe('liveBroadcasts.insert')
  })

  it('resumes an inconclusive reconcile and adopts the broadcast once the list covers it', async () => {
    const clock = new FakeClock()
    const h = await setUp({ clock })
    for (let index = 0; index < 200; index += 1) {
      h.server.seedBroadcast({
        title: `synthetic-unrelated-broadcast-${String(index)}`,
        lifeCycleStatus: 'ready',
        scheduledStartTime: `2026-01-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      })
    }
    const lifecycle = h.lifecycle()
    await withAppliedButUnknown(h, clock, 'liveBroadcasts.insert', () =>
      lifecycle.ensureBound().catch(() => undefined),
    )
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.pendingCall).toBe('liveBroadcasts.insert')

    // The unrelated broadcasts end; the list now fits inside the page bound.
    for (const broadcast of h.server.broadcasts.values()) {
      if (broadcast.title.startsWith('synthetic-unrelated-broadcast-')) {
        broadcast.lifeCycleStatus = 'complete'
      }
    }
    const resumed = await h.restart().resume()

    expect(resumed?.pendingCall).toBeNull()
    expect(resumed?.broadcastId).not.toBeNull()
    expect(h.server.requestsFor('liveBroadcasts.insert')).toHaveLength(1)
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
    h.temp.store.markBroadcastCallPending(
      attempt?.attemptId ?? '',
      'liveBroadcasts.transition',
      'live',
    )

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
    // broadcast exists at YouTube carrying this attempt's marker.
    h.server.queueFailure('liveBroadcasts.insert', { status: 503, reason: 'serviceUnavailable' })
    h.server.queueFailure('liveBroadcasts.insert', { status: 503, reason: 'serviceUnavailable' })
    await expect(first.ensureBound()).rejects.toThrow()

    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.broadcastId).toBeNull()
    h.temp.store.markBroadcastCallPending(attempt?.attemptId ?? '', 'liveBroadcasts.insert')
    const landed = h.server.seedBroadcast({
      scheduledStartTime: attempt?.scheduledStartTime ?? '',
      description: attempt?.attemptMarker ?? '',
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
    const otherStream = h.server.seedStream({ title: 'synthetic-other-ingest' })
    const other = h.server.seedBroadcast({
      title: h.config.title,
      lifeCycleStatus: 'live',
      boundStreamId: otherStream.id,
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

  it('adopts the candidate’s real binding and its vaulted key, not the one it had selected', async () => {
    // Review round 1 (B3) reproduction: recovery used to report our own stream while
    // YouTube was bound to another, leaving the wrong key in the vault (BOARD A-16).
    const h = await setUp()
    const otherStream = h.server.seedStream({ title: 'synthetic-other-ingest' })
    const candidate = h.server.seedBroadcast({
      title: h.config.title,
      lifeCycleStatus: 'live',
      boundStreamId: otherStream.id,
    })
    h.server.queueFailure('liveBroadcasts.insert', {
      status: 403,
      reason: 'userBroadcastsExceedLimit',
    })

    const target = await h.lifecycle().ensureLive()

    expect(target.broadcastId).toBe(candidate.id)
    // The returned target names the stream YouTube is actually bound to …
    expect(target.streamId).toBe(otherStream.id)
    expect(h.server.broadcasts.get(target.broadcastId)?.boundStreamId).toBe(target.streamId)
    // … and the vault carries that stream's key, not the one this host had picked.
    expect(await h.vault.get('youtube.streamKey')).toBe(otherStream.streamKey)
    expect(h.custodian.stagedStreamIds).toEqual([])
    const recovered = h.alerts.ofKind('broadcast_recovered')[0]
    expect(recovered?.detail['reboundStream']).toBe(true)
    // The row that had selected the other stream is closed, not silently repointed.
    const rows = h.temp.store.listBroadcastAttempts()
    expect(rows.some((row) => row.lastErrorReason === 'adopted_other_binding')).toBe(true)
    expect(rows.filter((row) => row.closedAt === null)).toHaveLength(1)
  })

  it('refuses a candidate whose bound stream cannot be keyed', async () => {
    const h = await setUp()
    const candidate = h.server.seedBroadcast({
      title: h.config.title,
      lifeCycleStatus: 'live',
      // Bound to a stream this channel does not expose: no key can be adopted, so
      // adopting the broadcast would mean streaming to an unknown destination.
      boundStreamId: 'synthetic-stream-not-listed',
    })
    h.server.queueFailure('liveBroadcasts.insert', {
      status: 403,
      reason: 'userBroadcastsExceedLimit',
    })

    await expect(h.lifecycle().ensureLive()).rejects.toThrow(BroadcastSafeStopRequiredError)

    expect(h.safeStops[0]?.reason).toBe('bound_stream_key_unavailable')
    expect(h.safeStops[0]?.detail['broadcastId']).toBe(candidate.id)
    expect(h.alerts.ofKind('broadcast_recovered')).toHaveLength(0)
    expect(h.custodian.stagedStreamIds).toEqual([])
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

describe('stopping a broadcast (review round 1, B4)', () => {
  it('keeps the attempt open when completing it left the outcome unknown', async () => {
    const h = await setUp({ maxAttempts: 1 })
    await h.lifecycle().ensureLive()
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    h.server.queueFailure('liveBroadcasts.transition', {
      status: 503,
      reason: 'serviceUnavailable',
    })
    const listsBefore = h.server.requestsFor('liveBroadcasts.list').length

    await expect(
      h.lifecycle().stopBroadcast(attempt as NonNullable<typeof attempt>),
    ).rejects.toThrow(BroadcastReconcileFailedError)

    // It reconciled (`list`) instead of assuming, and left the row open because
    // YouTube still says the broadcast is live.
    expect(h.server.requestsFor('liveBroadcasts.list').length).toBeGreaterThan(listsBefore)
    expect(h.server.broadcasts.get(attempt?.broadcastId ?? '')?.lifeCycleStatus).toBe('live')
    const after = h.temp.store.getBroadcastAttempt(attempt?.attemptId ?? '')
    expect(after?.closedAt).toBeNull()
    expect(after?.stage).toBe('live')
    expect(after?.lastErrorReason).toBe('reconciled_not_applied:live')
  })

  it('closes the attempt when the reconcile finds the broadcast already complete', async () => {
    const h = await setUp({ maxAttempts: 1 })
    await h.lifecycle().ensureLive()
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    // The transition is applied and then left unanswered, exactly like a timeout.
    h.server.queueFailure('liveBroadcasts.transition', {
      status: 503,
      reason: 'serviceUnavailable',
    })
    h.server.onRequest = (request) => {
      if (request.method === 'liveBroadcasts.transition') {
        const broadcast = h.server.broadcasts.get(attempt?.broadcastId ?? '')
        if (broadcast !== undefined) {
          broadcast.lifeCycleStatus = 'complete'
        }
      }
    }

    const closed = await h.lifecycle().stopBroadcast(attempt as NonNullable<typeof attempt>)

    expect(closed.stage).toBe('complete')
    expect(closed.closedAt).not.toBeNull()
    expect(closed.pendingCall).toBeNull()
    expect(h.temp.store.findOpenBroadcastAttempt()).toBeNull()
  })

  it('records which transition was in flight so a restart can read the status', async () => {
    const h = await setUp()
    await h.lifecycle().ensureBound()
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    h.temp.store.markBroadcastCallPending(
      attempt?.attemptId ?? '',
      'liveBroadcasts.transition',
      'complete',
    )
    const broadcast = h.server.broadcasts.get(attempt?.broadcastId ?? '')
    if (broadcast !== undefined) {
      broadcast.lifeCycleStatus = 'complete'
    }

    const resumed = await h.restart().resume()

    // A `complete` observation answers a stop, and would have been misread as
    // "not applied" without the persisted target.
    expect(resumed?.stage).toBe('complete')
    expect(resumed?.closedAt).not.toBeNull()
    expect(resumed?.pendingCall).toBeNull()
  })
})

describe('the attempt marker does not outlive its purpose (BOARD A-18)', () => {
  it('creates the broadcast private and removes the marker once the id is durable', async () => {
    const h = await setUp({ config: { privacyStatus: 'public', description: 'synthetic blurb' } })

    const binding = await h.lifecycle().ensureBound()

    const insert = h.server.requestsFor('liveBroadcasts.insert')[0]
    // Private at insert whatever the config asks for: the marker is in the description
    // and spec §9.1 keeps first publication with the operator.
    expect((insert?.body as { status: { privacyStatus: string } }).status.privacyStatus).toBe(
      'private',
    )
    const broadcast = h.server.broadcasts.get(binding.broadcastId)
    expect(broadcast?.privacyStatus).toBe('private')
    // The operator's text survives; only the marker is gone.
    expect(broadcast?.description).toBe('synthetic blurb')
    expect(broadcast?.title).toBe(h.config.title)
    expect(broadcast?.scheduledStartTime).not.toBeUndefined()
    const attempt = h.temp.store.getBroadcastAttempt(binding.attemptId)
    expect(attempt?.markerClearedAt).not.toBeNull()
    expect(h.alerts.ofKind('attempt_marker_cleared')).toHaveLength(1)
  })

  it('refuses to publish while the marker is still in the description', async () => {
    const h = await setUp({ config: { privacyStatus: 'public' } })
    const lifecycle = h.lifecycle()
    // Fail every attempt to clear the marker, so the description still carries it.
    for (let index = 0; index < 4; index += 1) {
      h.server.queueFailure('liveBroadcasts.update', { status: 403, reason: 'forbidden' })
    }
    await expect(lifecycle.ensureBound()).rejects.toThrow(YouTubeApiCallError)
    const attempt = h.temp.store.findOpenBroadcastAttempt()
    expect(attempt?.markerClearedAt).toBeNull()

    await expect(h.lifecycle().publish()).rejects.toThrow(BroadcastMarkerNotClearedError)

    const broadcast = h.server.broadcasts.get(attempt?.broadcastId ?? '')
    expect(broadcast?.privacyStatus).toBe('private')
    expect(broadcast?.description).toContain(attempt?.attemptMarker)
  })

  it('applies the configured privacy only after the marker is gone', async () => {
    const h = await setUp({ config: { privacyStatus: 'public' } })
    const binding = await h.lifecycle().ensureBound()

    await h.lifecycle().publish()

    const broadcast = h.server.broadcasts.get(binding.broadcastId)
    expect(broadcast?.privacyStatus).toBe('public')
    // The made-for-kids declaration was set at insert and is not updatable through this
    // method, so it is untouched rather than resent (review round 4, M2).
    expect(broadcast?.selfDeclaredMadeForKids).toBe(false)
    expect(broadcast?.description ?? '').not.toContain(binding.attemptId)
    expect(h.alerts.ofKind('broadcast_published').map((alert) => alert.reason)).toEqual(['public'])
  })

  it('preserves an operator-set end time and does not resend the title', async () => {
    // Review round 4 (M1). `scheduledEndTime` is writable and has no exemption from
    // deletion-on-omission, so it has to be read back and sent again; `snippet.title`
    // has been optional since 2023-08-01 and omission leaves it unchanged, so resending
    // a value read a moment ago would overwrite a concurrent Studio edit.
    const h = await setUp({ config: { description: 'synthetic blurb' } })
    const lifecycle = h.lifecycle()
    h.server.onRequest = (request) => {
      if (request.method === 'liveBroadcasts.insert') {
        queueMicrotask(() => {
          const broadcast = [...h.server.broadcasts.values()].at(-1)
          if (broadcast !== undefined) {
            // Both set outside this product: an end time, and a title edited in Studio
            // between the insert and the marker removal.
            broadcast.scheduledEndTime = '2026-01-01T12:00:00.000Z'
            broadcast.title = 'operator renamed this in Studio'
          }
        })
      }
    }

    const binding = await lifecycle.ensureBound()

    const update = h.server.requestsFor('liveBroadcasts.update')[0]
    const snippet = (update?.body as { snippet: Record<string, unknown> }).snippet
    expect(snippet['description']).toBe('synthetic blurb')
    expect(snippet['scheduledEndTime']).toBe('2026-01-01T12:00:00.000Z')
    expect(snippet['scheduledStartTime']).not.toBeUndefined()
    // Not sent at all — that is the point.
    expect(snippet['title']).toBeUndefined()
    expect(Object.keys(snippet).sort()).toEqual([
      'description',
      'scheduledEndTime',
      'scheduledStartTime',
    ])
    const broadcast = h.server.broadcasts.get(binding.broadcastId)
    expect(broadcast?.scheduledEndTime).toBe('2026-01-01T12:00:00.000Z')
    expect(broadcast?.title).toBe('operator renamed this in Studio')
    expect(broadcast?.description).toBe('synthetic blurb')
  })

  it('omits scheduledEndTime when the broadcast has none', async () => {
    const h = await setUp()

    await h.lifecycle().ensureBound()

    const snippet = (
      h.server.requestsFor('liveBroadcasts.update')[0]?.body as {
        snippet: Record<string, unknown>
      }
    ).snippet
    expect(Object.keys(snippet).sort()).toEqual(['description', 'scheduledStartTime'])
  })

  it('sends privacyStatus alone when publishing', async () => {
    // Review round 4 (M2): the update reference's writable list for `status` is
    // `privacyStatus` only, and the resource defines `selfDeclaredMadeForKids` for
    // insert and list. The fake rejects the unsupported member, so sending it would
    // fail this test rather than only production.
    const h = await setUp({ config: { privacyStatus: 'unlisted' } })
    await h.lifecycle().ensureBound()

    await h.lifecycle().publish()

    const publishUpdate = h.server.requestsFor('liveBroadcasts.update').at(-1)
    const status = (publishUpdate?.body as { status: Record<string, unknown> }).status
    expect(Object.keys(status)).toEqual(['privacyStatus'])
    expect(status['privacyStatus']).toBe('unlisted')
    expect((publishUpdate?.body as { snippet?: unknown }).snippet).toBeUndefined()
  })

  it('is checked by a fake server that rejects an unsupported update member', async () => {
    const h = await setUp()
    const broadcast = h.server.seedBroadcast()
    const url = new URL(`${h.server.baseUrl}/liveBroadcasts`)
    url.searchParams.set('part', 'id,status')

    const response = await fetch(url, {
      method: 'PUT',
      headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: broadcast.id,
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      }),
    })
    const body = (await response.json()) as { error: { errors: { reason: string }[] } }

    expect(response.status).toBe(400)
    expect(body.error.errors[0]?.reason).toBe('syntheticUnsupportedUpdateField')
    // And the broadcast was not touched by the refused request.
    expect(h.server.broadcasts.get(broadcast.id)?.privacyStatus).toBe('private')
  })

  it('refuses to publish when the configured privacy is private', async () => {
    const h = await setUp()
    await h.lifecycle().ensureBound()

    await expect(h.lifecycle().publish()).rejects.toThrow(/nothing to publish/)
  })

  it('reconciles a marker removal whose result was unknown', async () => {
    const h = await setUp({ maxAttempts: 2 })
    const lifecycle = h.lifecycle()
    // The update is applied and then answered with a 5xx-shaped unknown, so the
    // reconcile has to read the description back rather than assume.
    h.server.queueFailure('liveBroadcasts.update', { status: 503, reason: 'serviceUnavailable' })
    h.server.onRequest = (request) => {
      if (request.method === 'liveBroadcasts.update') {
        const attempt = h.temp.store.findOpenBroadcastAttempt()
        const broadcast = h.server.broadcasts.get(attempt?.broadcastId ?? '')
        if (broadcast !== undefined) {
          broadcast.description = undefined
        }
      }
    }

    const binding = await lifecycle.ensureBound()

    const attempt = h.temp.store.getBroadcastAttempt(binding.attemptId)
    expect(attempt?.markerClearedAt).not.toBeNull()
    // One update attempt: the reconcile found it had applied after all.
    expect(h.server.requestsFor('liveBroadcasts.update')).toHaveLength(1)
    expect(h.alerts.ofKind('call_reconciled').map((alert) => alert.reason)).toContain('applied')
  })

  it('leaves an adopted broadcast’s description alone', async () => {
    const h = await setUp()
    const otherStream = h.server.seedStream({ title: 'synthetic-other-ingest' })
    const candidate = h.server.seedBroadcast({
      title: h.config.title,
      lifeCycleStatus: 'live',
      boundStreamId: otherStream.id,
      description: 'someone else wrote this',
    })
    h.server.queueFailure('liveBroadcasts.insert', {
      status: 403,
      reason: 'userBroadcastsExceedLimit',
    })

    const target = await h.lifecycle().ensureLive()

    expect(target.broadcastId).toBe(candidate.id)
    // Nothing of ours was in it, so nothing was rewritten — and no update was sent.
    expect(h.server.broadcasts.get(candidate.id)?.description).toBe('someone else wrote this')
    expect(h.server.requestsFor('liveBroadcasts.update')).toHaveLength(0)
    expect(h.temp.store.getBroadcastAttempt(target.attemptId)?.markerClearedAt).not.toBeNull()
  })
})

describe('request shapes (review round 1, B1)', () => {
  it('only ever sends parts the method documents', async () => {
    const h = await setUp()
    await h.lifecycle().ensureLive()

    expect(h.server.requests.length).toBeGreaterThan(0)
    for (const request of h.server.requests) {
      const allowed = METHOD_ALLOWED_PARTS[request.method] ?? []
      const sent = (request.query['part'] ?? '').split(',').filter((part) => part !== '')
      expect(sent.length).toBeGreaterThan(0)
      expect(sent.filter((part) => !allowed.includes(part))).toEqual([])
    }
    // The specific regression: `liveStreams.list` does not accept contentDetails.
    for (const request of h.server.requestsFor('liveStreams.list')) {
      expect(request.query['part']).not.toContain('contentDetails')
    }
  })

  it('is checked by a fake server that rejects an unsupported part', async () => {
    const h = await setUp()
    const url = new URL(`${h.server.baseUrl}/liveStreams`)
    url.searchParams.set('mine', 'true')
    url.searchParams.set('part', 'id,snippet,cdn,contentDetails,status')

    const response = await fetch(url, { headers: { authorization: 'Bearer synthetic' } })
    const body = (await response.json()) as { error: { errors: { reason: string }[] } }

    expect(response.status).toBe(400)
    expect(body.error.errors[0]?.reason).toBe('unexpectedPart')
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

  it('is not even requested by the status poll (review round 1, M1)', async () => {
    const h = await setUp()
    const target = await h.lifecycle().ensureLive()
    expect(h.custodian.stagedStreamIds).toEqual([])

    const monitor = new BroadcastHealthMonitor({
      api: h.api,
      config: h.config,
      onSignal: () => {},
      resources: () => ({ streamId: target.streamId, broadcastId: target.broadcastId }),
      clock: h.temp.clock,
    })
    await monitor.poll()
    await monitor.poll()

    // The poll asks for `id,status` only, so no key ever enters the process and
    // nothing can be left staged outside the vault.
    const polls = h.server
      .requestsFor('liveStreams.list')
      .filter((request) => request.query['part'] === 'id,status')
    expect(polls).toHaveLength(2)
    expect(polls.every((request) => !(request.query['part'] ?? '').includes('cdn'))).toBe(true)
    expect(h.custodian.stagedStreamIds).toEqual([])
  })

  it('leaves nothing staged when the stream lookup finds no match', async () => {
    const h = await setUp()
    h.server.seedStream({ title: 'synthetic-someone-elses-stream' })
    h.server.queueFailure('liveStreams.insert', { status: 403, reason: 'liveStreamingNotEnabled' })

    await expect(h.lifecycle().ensureBound()).rejects.toThrow(YouTubeApiCallError)

    // The list carried another stream's key; the failed insert must not leave it
    // staged (review round 1, M1).
    expect(h.custodian.stagedStreamIds).toEqual([])
    expect(await h.vault.get('youtube.streamKey')).toBeUndefined()
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
