import { afterEach, describe, expect, it } from 'vitest'

import { PersistenceInvariantError, ProcessedCursorError, StateRevisionError } from './errors.js'
import { openDatabase } from './open.js'
import {
  checkpointInput,
  giftBaseKey,
  grpcEnvelope,
  makePaidEffect,
  makeSnapshot,
} from './testing/fixtures.js'
import { createTempStore, TEST_BUSY_TIMEOUT_MS, type TempStore } from './testing/temp-store.js'
import type { StateTransitionInput } from './types.js'

/**
 * `commitStateTransition`: snapshot, revision, processed sequence, processing
 * record, deadlines, effect outbox, paid ledger and gift maxima in one
 * transaction (spec §7.3(5)).
 */

let temp: TempStore | undefined

afterEach(() => {
  temp?.dispose()
  temp = undefined
})

function open(): TempStore {
  temp = createTempStore()
  return temp
}

function transition(overrides: Partial<StateTransitionInput> = {}): StateTransitionInput {
  const revision = overrides.revision ?? 1
  const processedSeq = overrides.processedSeq ?? 0
  return {
    snapshot: makeSnapshot({ stateRevision: revision, processedIngestSeq: processedSeq }),
    revision,
    processedSeq,
    transitions: [
      {
        revision,
        causedByEventKey: null,
        kind: 'test_tick',
        at: '2026-08-16T00:05:00.000Z',
      },
    ],
    ...overrides,
  }
}

describe('commitStateTransition', () => {
  it('commits the snapshot, the revision and the processed sequence', () => {
    const { store } = open()
    const result = store.commitStateTransition(transition({ revision: 4, processedSeq: 7 }))

    expect(result.stateRevision).toBe(4)
    expect(result.processedIngestSeq).toBe(7)

    const recovery = store.loadRecoveryState()
    expect(recovery.stateRevision).toBe(4)
    expect(recovery.processedIngestSeq).toBe(7)
    expect(recovery.snapshot?.stateRevision).toBe(4)
  })

  it('marks the inbox rows it processed, with a reason', () => {
    const handle = open()
    handle.store.commitIngestBatch(
      [grpcEnvelope('text-message-event'), grpcEnvelope('unsupported-chat-ended-event')],
      checkpointInput(),
    )

    handle.store.commitStateTransition(
      transition({
        revision: 1,
        processedSeq: 2,
        processed: [
          { ingestSeq: 1, result: 'applied' },
          // Unsupported rows advance with a reason instead of stalling the drain
          // (spec §7.3(3)).
          { ingestSeq: 2, result: 'unsupported' },
        ],
      }),
    )

    expect(handle.store.drainUnprocessed(0, 10)).toEqual([])
  })

  it('rejects a revision that does not advance', () => {
    const { store } = open()
    store.commitStateTransition(transition({ revision: 2, processedSeq: 0 }))
    expect(() => store.commitStateTransition(transition({ revision: 2, processedSeq: 1 }))).toThrow(
      StateRevisionError,
    )
    expect(() => store.commitStateTransition(transition({ revision: 1, processedSeq: 1 }))).toThrow(
      StateRevisionError,
    )
    expect(store.loadRecoveryState().stateRevision).toBe(2)
  })

  it('rejects a processed sequence that moves backwards', () => {
    const { store } = open()
    store.commitStateTransition(transition({ revision: 1, processedSeq: 5 }))
    expect(() => store.commitStateTransition(transition({ revision: 2, processedSeq: 4 }))).toThrow(
      StateRevisionError,
    )
    expect(store.loadRecoveryState().processedIngestSeq).toBe(5)
  })

  it('rejects a snapshot that disagrees with its own commit', () => {
    const { store } = open()
    expect(() =>
      store.commitStateTransition({
        snapshot: makeSnapshot({ stateRevision: 9, processedIngestSeq: 0 }),
        revision: 1,
        processedSeq: 0,
      }),
    ).toThrow(/snapshot.stateRevision/)
    expect(() =>
      store.commitStateTransition({
        snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 3 }),
        revision: 1,
        processedSeq: 0,
      }),
    ).toThrow(/snapshot.processedIngestSeq/)
    expect(store.loadRecoveryState().snapshot).toBeNull()
  })

  it('rejects a transition revision outside the committed window', () => {
    const { store } = open()
    expect(() =>
      store.commitStateTransition(
        transition({
          revision: 2,
          transitions: [
            {
              revision: 3,
              causedByEventKey: null,
              kind: 'test_tick',
              at: '2026-08-16T00:05:00.000Z',
            },
          ],
        }),
      ),
    ).toThrow(StateRevisionError)
    expect(store.loadRecoveryState().snapshot).toBeNull()
  })

  it('rejects an inbox row it cannot mark as processed', () => {
    const { store } = open()
    expect(() =>
      store.commitStateTransition(
        transition({ processed: [{ ingestSeq: 42, result: 'applied' }] }),
      ),
    ).toThrow(PersistenceInvariantError)
    expect(store.loadRecoveryState().snapshot).toBeNull()
  })

  it('records paid audit rows once, no matter how often the event is replayed', () => {
    const { store } = open()
    const eventKey = 'youtube:brd_test_0001:msg_test_0003'
    const paidLedger = [
      {
        eventKey,
        kind: 'SUPER_CHAT' as const,
        amountMicros: 500_000_000,
        currency: 'JPY',
        tier: 1,
        jewels: null,
        appliedAt: '2026-08-16T00:05:00.000Z',
      },
    ]

    const first = store.commitStateTransition(transition({ revision: 1, paidLedger }))
    const second = store.commitStateTransition(transition({ revision: 2, paidLedger }))

    expect(first.paidLedgerInserted).toEqual([eventKey])
    expect(first.paidLedgerDuplicate).toEqual([])
    expect(second.paidLedgerInserted).toEqual([])
    expect(second.paidLedgerDuplicate).toEqual([eventKey])
  })

  it('writes an effect once and reports a replayed effect id as a duplicate', () => {
    const { store } = open()
    const effect = makePaidEffect({ effectId: 'eff_test_replay', stateRevision: 1 })

    const first = store.commitStateTransition(transition({ revision: 1, effects: [effect] }))
    const second = store.commitStateTransition(transition({ revision: 2, effects: [effect] }))

    expect(first.effectsInserted).toEqual(['eff_test_replay'])
    expect(second.effectsInserted).toEqual([])
    expect(second.effectsDuplicate).toEqual(['eff_test_replay'])
    expect(store.getEffect('eff_test_replay')?.effect).toEqual(effect)
  })

  it('rejects an effect produced after the committed revision', () => {
    const { store } = open()
    expect(() =>
      store.commitStateTransition(
        transition({ revision: 1, effects: [makePaidEffect({ stateRevision: 2 })] }),
      ),
    ).toThrow(StateRevisionError)
    expect(store.loadRecoveryState().unackedEffects).toEqual([])
  })

  it('stores deadlines with their downtime policy', () => {
    const { store } = open()
    store.commitStateTransition(
      transition({
        deadlines: [
          {
            id: 'dl_test_choice',
            kind: 'choice_window',
            dueAt: '2026-08-16T00:06:00.000Z',
            policy: 'coalesce',
            payload: { missionId: 'test_mission' },
            status: 'pending',
          },
        ],
      }),
    )

    const pending = store.listPendingDeadlines()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.policy).toBe('coalesce')
    expect(pending[0]?.payload).toEqual({ missionId: 'test_mission' })
  })

  it('crash window "while writing state" leaves no partial commit', () => {
    const handle = open()
    handle.store.commitIngestBatch([grpcEnvelope('text-message-event')], checkpointInput())
    handle.store.commitStateTransition(transition({ revision: 1, processedSeq: 0 }))

    // The deadline payload is written after the snapshot, the transitions and the
    // processing record. A payload `JSON.stringify` cannot serialize raises there,
    // i.e. in the middle of the state write (TASK_SPECS §T4 합격 기준 1).
    expect(() =>
      handle.store.commitStateTransition(
        transition({
          revision: 2,
          processedSeq: 1,
          processed: [{ ingestSeq: 1, result: 'applied' }],
          effects: [makePaidEffect({ effectId: 'eff_test_never', stateRevision: 2 })],
          deadlines: [
            {
              id: 'dl_test_bad_payload',
              kind: 'choice_window',
              dueAt: '2026-08-16T00:06:00.000Z',
              policy: 'skip',
              payload: { count: 1n },
              status: 'pending',
            },
          ],
          giftCombo: [{ baseKey: giftBaseKey(), effectiveCount: 3 }],
        }),
      ),
    ).toThrow(TypeError)

    const recovery = handle.store.loadRecoveryState()
    expect(recovery.stateRevision).toBe(1)
    expect(recovery.snapshot?.stateRevision).toBe(1)
    expect(recovery.processedIngestSeq).toBe(0)
    expect(recovery.unackedEffects).toEqual([])
    expect(recovery.dueDeadlines).toEqual([])
    expect(handle.store.getGiftStoredMax(giftBaseKey())).toBe(0)
    // The inbox row is still unprocessed, so the drain replays it after restart.
    expect(handle.store.drainUnprocessed(0, 10).map((row) => row.ingestSeq)).toEqual([1])
  })

  it('refuses to move the recovery cursor past an unprocessed inbox row', () => {
    const handle = open()
    handle.store.commitIngestBatch([grpcEnvelope('text-message-event')], checkpointInput())

    // Reported on PR #5 review round 1: the cursor used to advance on the
    // caller's word alone, burying the row below where the restart resumes.
    expect(() =>
      handle.store.commitStateTransition(transition({ revision: 1, processedSeq: 1 })),
    ).toThrow(ProcessedCursorError)

    expect(handle.store.loadRecoveryState().snapshot).toBeNull()
    expect(handle.store.loadRecoveryState().processedIngestSeq).toBe(0)
    expect(handle.store.drainFromRecoveryCursor(10).map((row) => row.ingestSeq)).toEqual([1])
  })

  it('refuses a gap in the middle of the cursor window', () => {
    const handle = open()
    handle.store.commitIngestBatch(
      [
        grpcEnvelope('text-message-event'),
        grpcEnvelope('text-message-event-noise'),
        grpcEnvelope('super-chat-event'),
      ],
      checkpointInput(),
    )

    expect(() =>
      handle.store.commitStateTransition(
        transition({
          revision: 1,
          processedSeq: 3,
          processed: [
            { ingestSeq: 1, result: 'applied' },
            // 2 is skipped.
            { ingestSeq: 3, result: 'applied' },
          ],
        }),
      ),
    ).toThrow(/unprocessed inbox rows 2/)
    expect(handle.store.drainFromRecoveryCursor(10).map((row) => row.ingestSeq)).toEqual([1, 2, 3])
  })

  it('refuses a processing record outside the cursor window', () => {
    const handle = open()
    handle.store.commitIngestBatch(
      [grpcEnvelope('text-message-event'), grpcEnvelope('super-chat-event')],
      checkpointInput(),
    )
    expect(() =>
      handle.store.commitStateTransition(
        transition({
          revision: 1,
          processedSeq: 1,
          processed: [
            { ingestSeq: 1, result: 'applied' },
            { ingestSeq: 2, result: 'applied' },
          ],
        }),
      ),
    ).toThrow(/outside the cursor window \(0, 1\]/)
  })

  it('refuses processing records that are out of order or repeated', () => {
    const handle = open()
    handle.store.commitIngestBatch(
      [grpcEnvelope('text-message-event'), grpcEnvelope('super-chat-event')],
      checkpointInput(),
    )
    for (const processed of [
      [
        { ingestSeq: 2, result: 'applied' },
        { ingestSeq: 1, result: 'applied' },
      ],
      [
        { ingestSeq: 1, result: 'applied' },
        { ingestSeq: 1, result: 'applied' },
      ],
    ]) {
      expect(() =>
        handle.store.commitStateTransition(transition({ revision: 1, processedSeq: 2, processed })),
      ).toThrow(ProcessedCursorError)
    }
    expect(handle.store.loadRecoveryState().processedIngestSeq).toBe(0)
  })

  it('lets the cursor pass a sequence whose row is gone (retention, T13)', () => {
    const handle = open()
    handle.store.commitIngestBatch(
      [grpcEnvelope('text-message-event'), grpcEnvelope('super-chat-event')],
      checkpointInput(),
    )
    const raw = openDatabase({ file: handle.file, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS })
    try {
      raw.prepare('DELETE FROM ingest_inbox WHERE ingest_seq = 1').run()
    } finally {
      raw.close()
    }

    // Nothing is stranded: the row no longer exists, so the cursor may pass it.
    const result = handle.store.commitStateTransition(
      transition({
        revision: 1,
        processedSeq: 2,
        processed: [{ ingestSeq: 2, result: 'applied' }],
      }),
    )
    expect(result.processedIngestSeq).toBe(2)
  })

  it('leaves an unprocessed row drainable across a restart (spec §7.3(3))', () => {
    const handle = open()
    handle.store.commitIngestBatch(
      [
        grpcEnvelope('text-message-event'),
        grpcEnvelope('text-message-event-noise'),
        grpcEnvelope('super-chat-event'),
      ],
      checkpointInput(),
    )
    // The writer got through the first two rows only.
    handle.store.commitStateTransition(
      transition({
        revision: 1,
        processedSeq: 2,
        processed: [
          { ingestSeq: 1, result: 'applied' },
          { ingestSeq: 2, result: 'unsupported' },
        ],
      }),
    )

    const reopened = handle.reopen()
    const recovery = reopened.loadRecoveryState()
    expect(recovery.processedIngestSeq).toBe(2)
    // The third row survives the restart above the cursor and is replayed.
    expect(reopened.drainFromRecoveryCursor(10).map((row) => row.ingestSeq)).toEqual([3])
    expect(reopened.drainUnprocessed(recovery.processedIngestSeq, 10)).toHaveLength(1)
  })

  it('survives a reopen with the last committed revision (spec §11 상태 복구)', () => {
    const handle = open()
    handle.store.commitStateTransition(
      transition({
        revision: 3,
        processedSeq: 2,
        effects: [makePaidEffect({ effectId: 'eff_test_durable', stateRevision: 3 })],
      }),
    )

    const reopened = handle.reopen()
    const recovery = reopened.loadRecoveryState()
    expect(recovery.stateRevision).toBe(3)
    expect(recovery.processedIngestSeq).toBe(2)
    expect(recovery.unackedEffects.map((row) => row.effect.effectId)).toEqual(['eff_test_durable'])
  })
})
