import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_WORLD_ID } from './store.js'
import {
  checkpointInput,
  grpcEnvelope,
  makePaidEffect,
  makeSnapshot,
  TEST_SOURCE_KEY,
} from './testing/fixtures.js'
import { createTempStore, type TempStore } from './testing/temp-store.js'
import type { DeadlineRecord } from './types.js'

/**
 * Startup recovery (spec §7.3(3), §11 상태 복구): the last snapshot, its revision
 * and processed sequence, the effects still open, the deadlines already due and
 * the reconnect checkpoints — everything the writer needs before it resumes.
 */

let temp: TempStore | undefined

afterEach(() => {
  temp?.dispose()
  temp = undefined
})

function open(worldId?: string): TempStore {
  temp = createTempStore(worldId === undefined ? {} : { worldId })
  return temp
}

function deadline(overrides: Partial<DeadlineRecord>): DeadlineRecord {
  return {
    id: 'dl_test_0001',
    kind: 'choice_window',
    dueAt: '2026-08-16T00:06:00.000Z',
    policy: 'replay',
    payload: null,
    status: 'pending',
    ...overrides,
  }
}

describe('loadRecoveryState', () => {
  it('reports an empty world before the first commit', () => {
    const { store } = open()
    expect(store.loadRecoveryState('2026-08-16T00:05:00.000Z')).toEqual({
      snapshot: null,
      stateRevision: 0,
      processedIngestSeq: 0,
      unackedEffects: [],
      dueDeadlines: [],
      checkpoints: [],
    })
    expect(store.getSourceCheckpoint('youtube:unknown')).toBeNull()
  })

  it('returns the last snapshot, the open effects, the due deadlines and the checkpoints', () => {
    const { store } = open()
    store.commitIngestBatch([grpcEnvelope('text-message-event')], checkpointInput('token_page_9'))
    store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 5, processedIngestSeq: 1 }),
      revision: 5,
      processedSeq: 1,
      processed: [{ ingestSeq: 1, result: 'applied' }],
      effects: [makePaidEffect({ effectId: 'eff_test_open', stateRevision: 5 })],
      deadlines: [
        deadline({ id: 'dl_test_due', dueAt: '2026-08-16T00:04:00.000Z' }),
        deadline({ id: 'dl_test_future', dueAt: '2026-08-16T01:00:00.000Z' }),
        deadline({ id: 'dl_test_fired', dueAt: '2026-08-16T00:03:00.000Z', status: 'fired' }),
      ],
    })

    const recovery = store.loadRecoveryState('2026-08-16T00:05:00.000Z')

    expect(recovery.stateRevision).toBe(5)
    expect(recovery.processedIngestSeq).toBe(1)
    expect(recovery.snapshot).toEqual(makeSnapshot({ stateRevision: 5, processedIngestSeq: 1 }))
    expect(recovery.unackedEffects.map((row) => row.effect.effectId)).toEqual(['eff_test_open'])
    // Only pending deadlines that are already due; a fired one is history and a
    // future one is not this restart's work.
    expect(recovery.dueDeadlines.map((row) => row.id)).toEqual(['dl_test_due'])
    expect(recovery.checkpoints).toEqual([
      {
        sourceKey: TEST_SOURCE_KEY,
        liveChatId: 'chat_test_0001',
        nextPageToken: 'token_page_9',
        lastIngestSeq: 1,
        updatedAt: expect.any(String) as unknown as string,
      },
    ])
  })

  it('drops an acked or expired effect from the open set', () => {
    const { store } = open()
    store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 0 }),
      revision: 1,
      processedSeq: 0,
      effects: [
        makePaidEffect({ effectId: 'eff_test_acked', stateRevision: 1 }),
        makePaidEffect({ effectId: 'eff_test_expired', stateRevision: 1 }),
        makePaidEffect({ effectId: 'eff_test_open', stateRevision: 1 }),
      ],
    })
    store.markEffectPublished('eff_test_acked')
    store.markEffectAcked('eff_test_acked')
    store.markEffectExpired('eff_test_expired')

    expect(store.loadRecoveryState().unackedEffects.map((row) => row.effect.effectId)).toEqual([
      'eff_test_open',
    ])
  })

  it('lists every pending deadline with its policy when no instant is given', () => {
    const { store } = open()
    store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 0 }),
      revision: 1,
      processedSeq: 0,
      deadlines: [
        deadline({ id: 'dl_test_b', dueAt: '2026-08-16T02:00:00.000Z', policy: 'skip' }),
        deadline({ id: 'dl_test_a', dueAt: '2026-08-16T01:00:00.000Z', policy: 'coalesce' }),
      ],
    })
    // The restart has to re-arm future timers too, so this is not filtered by
    // time; the replay/coalesce/skip decision itself belongs to T8 (spec §10.2).
    expect(store.listPendingDeadlines().map((row) => [row.id, row.policy])).toEqual([
      ['dl_test_a', 'coalesce'],
      ['dl_test_b', 'skip'],
    ])
  })

  it('updates a deadline in place when the writer changes its status', () => {
    const { store } = open()
    store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 0 }),
      revision: 1,
      processedSeq: 0,
      deadlines: [deadline({ id: 'dl_test_once' })],
    })
    store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 2, processedIngestSeq: 0 }),
      revision: 2,
      processedSeq: 0,
      deadlines: [deadline({ id: 'dl_test_once', status: 'fired' })],
    })
    expect(store.listPendingDeadlines()).toEqual([])
  })

  it('keeps a second world independent', () => {
    const first = open('world_a')
    first.store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 3, processedIngestSeq: 0 }),
      revision: 3,
      processedSeq: 0,
    })
    expect(first.store.worldId).toBe('world_a')

    // Same file, other world id: the snapshot row is keyed by world, so the
    // second world starts empty (spec §10.2 — V1 uses one).
    const second = createTempStore({ worldId: DEFAULT_WORLD_ID })
    try {
      expect(second.store.loadRecoveryState().snapshot).toBeNull()
      expect(second.store.worldId).toBe('default')
    } finally {
      second.dispose()
    }
  })
})
