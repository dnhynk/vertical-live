import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PersistenceInvariantError } from './errors.js'
import { openDatabase } from './open.js'
import { createTempStore, TEST_BUSY_TIMEOUT_MS, type TempStore } from './testing/temp-store.js'
import type { BroadcastAttemptInput } from './types.js'

/**
 * `broadcast_resources` (migration 003) is the durable answer to "what did this host
 * already do at YouTube?" (spec §9.1). These tests pin the properties the lifecycle
 * relies on: a call is recorded before it is made, its attempt marker is recorded
 * with it, a stage never moves backwards, and an external id is write-once.
 */

const ATTEMPT: BroadcastAttemptInput = {
  attemptId: 'attempt-0001',
  strategy: 'single',
  streamTitle: 'vertical-live ingest (synthetic test)',
  scheduledStartTime: '2026-01-01T00:02:00.000Z',
  attemptMarker: 'vl-attempt:attempt-0001',
}

let temp: TempStore

beforeEach(() => {
  temp = createTempStore()
})

afterEach(() => {
  temp.dispose()
})

describe('broadcast attempts', () => {
  it('starts at stage planned with no external ids and nothing pending', () => {
    const record = temp.store.beginBroadcastAttempt(ATTEMPT)

    expect(record).toMatchObject({
      attemptId: ATTEMPT.attemptId,
      strategy: 'single',
      stage: 'planned',
      // Written before any call: it is what identifies the insert's result later
      // (review round 2, B1).
      attemptMarker: ATTEMPT.attemptMarker,
      pendingCall: null,
      pendingSince: null,
      streamId: null,
      broadcastId: null,
      liveChatId: null,
      autoStart: null,
      closedAt: null,
    })
    expect(temp.store.findOpenBroadcastAttempt()).toEqual(record)
  })

  it('keeps the pending call visible after a reopen, so a restart reconciles', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveBroadcasts.insert')

    const reopened = temp.reopen()
    const resumed = reopened.findOpenBroadcastAttempt()

    expect(resumed?.pendingCall).toBe('liveBroadcasts.insert')
    expect(resumed?.pendingSince).not.toBeNull()
  })

  it('clears the pending marker when a call result is recorded', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveStreams.insert')

    const resolved = temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, {
      stage: 'stream_ready',
      streamId: 'synthetic-stream-1',
    })

    expect(resolved.pendingCall).toBeNull()
    expect(resolved.pendingSince).toBeNull()
    expect(resolved.stage).toBe('stream_ready')
    expect(resolved.streamId).toBe('synthetic-stream-1')
  })

  it('records which transition is in flight, and refuses one without a target', () => {
    // Review round 1 (B4): the observed `lifeCycleStatus` is only readable against
    // the target the call asked for, so the target is part of the pending marker.
    temp.store.beginBroadcastAttempt(ATTEMPT)

    expect(() =>
      temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveBroadcasts.transition'),
    ).toThrow(/must record its target status/)
    expect(() =>
      temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveBroadcasts.bind', 'live'),
    ).toThrow(/has no transition target/)

    const pending = temp.store.markBroadcastCallPending(
      ATTEMPT.attemptId,
      'liveBroadcasts.transition',
      'complete',
    )
    expect(pending.pendingTransition).toBe('complete')

    const resolved = temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, {})
    expect(resolved.pendingCall).toBeNull()
    expect(resolved.pendingTransition).toBeNull()
  })

  it('refuses a second in-flight call while one is unresolved', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveBroadcasts.insert')

    expect(() =>
      temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveBroadcasts.bind'),
    ).toThrow(PersistenceInvariantError)
  })

  it('allows re-marking the same call (a retry of the same step)', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveBroadcasts.insert')

    expect(() =>
      temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveBroadcasts.insert'),
    ).not.toThrow()
  })

  it('refuses a stage that would move backwards', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, { stage: 'bound' })

    expect(() =>
      temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, { stage: 'stream_ready' }),
    ).toThrow(/cannot move from stage bound to stream_ready/)
  })

  it('allows abandoning from any stage', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, { stage: 'bound' })

    const closed = temp.store.closeBroadcastAttempt(
      ATTEMPT.attemptId,
      'abandoned',
      'userBroadcastsExceedLimit',
    )

    expect(closed.stage).toBe('abandoned')
    expect(closed.closedAt).not.toBeNull()
    expect(closed.lastErrorReason).toBe('userBroadcastsExceedLimit')
    expect(temp.store.findOpenBroadcastAttempt()).toBeNull()
  })

  it('refuses to repoint an attempt at another broadcast', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, {
      stage: 'broadcast_created',
      broadcastId: 'synthetic-broadcast-1',
    })

    expect(() =>
      temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, {
        broadcastId: 'synthetic-broadcast-2',
      }),
    ).toThrow(/already points at broadcastId/)
  })

  it('refuses two attempts claiming the same broadcast id', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, {
      stage: 'broadcast_created',
      broadcastId: 'synthetic-broadcast-1',
    })
    temp.store.beginBroadcastAttempt({ ...ATTEMPT, attemptId: 'attempt-0002' })

    expect(() =>
      temp.store.recordBroadcastCallResult('attempt-0002', {
        stage: 'broadcast_created',
        broadcastId: 'synthetic-broadcast-1',
      }),
    ).toThrow()
  })

  it('records the auto-start outcome as a tri-state', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    expect(temp.store.getBroadcastAttempt(ATTEMPT.attemptId)?.autoStart).toBeNull()

    temp.store.recordBroadcastCallResult(ATTEMPT.attemptId, { autoStart: false })
    expect(temp.store.getBroadcastAttempt(ATTEMPT.attemptId)?.autoStart).toBe(false)
  })

  it('refuses a call on a closed attempt', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.closeBroadcastAttempt(ATTEMPT.attemptId, 'complete')

    expect(() =>
      temp.store.markBroadcastCallPending(ATTEMPT.attemptId, 'liveBroadcasts.transition'),
    ).toThrow(/is closed/)
  })

  it('requires an attempt marker', () => {
    expect(() =>
      temp.store.beginBroadcastAttempt({
        ...ATTEMPT,
        attemptId: 'attempt-nomarker',
        attemptMarker: '',
      }),
    ).toThrow(/attemptMarker must be a non-empty string/)
  })

  it('rejects an unknown attempt id', () => {
    expect(() => temp.store.markBroadcastCallPending('nope', 'liveBroadcasts.bind')).toThrow(
      /unknown broadcast attempt/,
    )
    expect(temp.store.getBroadcastAttempt('nope')).toBeNull()
  })

  it('lists attempts newest first', () => {
    temp.store.beginBroadcastAttempt(ATTEMPT)
    temp.store.closeBroadcastAttempt(ATTEMPT.attemptId, 'complete')
    temp.store.beginBroadcastAttempt({ ...ATTEMPT, attemptId: 'attempt-0002' })

    expect(temp.store.listBroadcastAttempts().map((row) => row.attemptId)).toEqual([
      'attempt-0002',
      'attempt-0001',
    ])
  })

  it('has no column that could hold a stream key', () => {
    // Acceptance 2 (§T10): the vault is the stream key's only home (BOARD A-16),
    // and `cdn.ingestionInfo.streamName` *is* the key. A column for it would make
    // a leak a one-line change, so the schema itself has to lack one.
    const database = openDatabase({ file: temp.file, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS })
    try {
      const columns = (
        database.prepare('SELECT name FROM pragma_table_info(?)').all('broadcast_resources') as {
          name: string
        }[]
      ).map((row) => row.name)

      expect(columns).toContain('stream_title')
      expect(columns.filter((name) => /key|secret|name/.test(name))).toEqual([])
    } finally {
      database.close()
    }
  })
})
