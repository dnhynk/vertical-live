import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { eventKeyFor } from '@vl/contract'

import { makeSnapshot } from '../db/testing/fixtures.js'
import { giftBaseKey } from './engine.js'
import {
  TEST_BROADCAST_ID,
  at,
  createEngineHarness,
  giftEnvelope,
  ingest,
  resetMessageIds,
  restartEngine,
  superChatEnvelope,
  type EngineHarness,
} from './testing/harness.js'

/**
 * Paid integrity (TASK_SPECS §T8 acceptance 2, spec §7.4, §11 유료 무결성).
 *
 * Three independent guarantees, each with its own idempotency unit:
 * the inbox index over the event key, the paid ledger's primary key, and the
 * non-decreasing gift maximum. A test exists for each, plus one for the outbox:
 * republishing a paid effect must never write a second row.
 */

describe('paid integrity', () => {
  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness()
  })

  afterEach(() => {
    harness.dispose()
  })

  it('applies the same Super Chat once however often it is delivered', async () => {
    harness.engine.start()
    const envelope = superChatEnvelope({ messageId: 'msg_test_sc_dup', receivedAt: at(1_000) })
    ingest(harness.store, [envelope])
    ingest(harness.store, [envelope])
    await harness.clock.advance(1_000)

    harness.engine.runPending()

    const paidEffects = harness.publisher.effects.filter((effect) => effect.paid)
    expect(paidEffects).toHaveLength(1)
    expect(paidEffects[0]?.kind).toBe('PAID_THANKS')
    expect(paidEffects[0]?.causedByEventKey).toBe(
      eventKeyFor({
        source: 'simulator',
        broadcastId: TEST_BROADCAST_ID,
        messageId: 'msg_test_sc_dup',
      }),
    )
    expect(
      harness.store.hasPaidLedgerEntry(paidEffects[0]?.causedByEventKey as string),
    ).toBe(true)
  })

  it('never stages an event the ledger already holds, whatever wrote it', async () => {
    const eventKey = eventKeyFor({
      source: 'simulator',
      broadcastId: TEST_BROADCAST_ID,
      messageId: 'msg_test_sc_seeded',
    })
    // A previous run acknowledged this event; only the ledger survived in view.
    harness.store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 1 }),
      revision: 1,
      processedSeq: 0,
      paidLedger: [
        {
          eventKey,
          kind: 'SUPER_CHAT',
          amountMicros: 500_000,
          currency: 'JPY',
          tier: 1,
          jewels: null,
          appliedAt: at(0),
        },
      ],
    })
    harness.engine.start()
    ingest(harness.store, [
      superChatEnvelope({ messageId: 'msg_test_sc_seeded', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)

    harness.engine.runPending()

    expect(harness.publisher.effects.filter((effect) => effect.paid)).toHaveLength(0)
    expect(harness.engine.metrics().counters['paid_duplicate']).toBe(1)
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('applies only the increase of a gift combo (spec §7.4)', async () => {
    harness.engine.start()
    const messageId = 'msg_test_gift_combo'
    for (const [index, comboCount] of [0, 1, 3, 5, 3].entries()) {
      ingest(harness.store, [
        giftEnvelope({ messageId, comboCount, receivedAt: at(1_000 + index * 100) }),
      ])
    }
    await harness.clock.advance(2_000)

    harness.engine.runPending()

    // comboCount 0 and 1 are both `effectiveCount = 1`, so they are one inbox
    // row; the second `3` repeats a key. Three rows survive, and the deltas
    // 1, 2, 2 are what the world acknowledged.
    const paidEffects = harness.publisher.effects.filter((effect) => effect.paid)
    expect(paidEffects).toHaveLength(3)
    const base = giftBaseKey(paidEffects[0]?.causedByEventKey as string)
    expect(harness.store.getGiftStoredMax(base)).toBe(5)
    expect(paidEffects.map((effect) => effect.causedByEventKey)).toEqual([
      `${base}:gift:1`,
      `${base}:gift:3`,
      `${base}:gift:5`,
    ])
  })

  it('stages nothing for a combo step that arrives below the stored maximum', async () => {
    harness.engine.start()
    const messageId = 'msg_test_gift_late'
    ingest(harness.store, [giftEnvelope({ messageId, comboCount: 5, receivedAt: at(1_000) })])
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    ingest(harness.store, [giftEnvelope({ messageId, comboCount: 3, receivedAt: at(1_500) })])
    await harness.clock.advance(1_000)

    harness.engine.runPending()

    expect(harness.publisher.effects.filter((effect) => effect.paid)).toHaveLength(1)
    expect(harness.engine.metrics().counters['gift_no_delta']).toBe(1)
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('republishes a paid effect without writing a second outbox row', async () => {
    harness.engine.start()
    ingest(harness.store, [
      superChatEnvelope({ messageId: 'msg_test_sc_restart', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    const paid = harness.publisher.effects.find((effect) => effect.paid)
    expect(paid).toBeDefined()
    const before = harness.store.listUnackedEffects().length

    const restarted = restartEngine(harness)
    restarted.engine.start()

    const republished = restarted.publisher.effects.filter(
      (effect) => effect.effectId === paid?.effectId,
    )
    expect(republished.length).toBeGreaterThan(0)
    expect(restarted.store.listUnackedEffects().length).toBe(before)
    restarted.engine.stop()
  })

  it('acknowledges a paid effect once the renderer played it', async () => {
    harness.engine.start()
    ingest(harness.store, [
      superChatEnvelope({ messageId: 'msg_test_sc_ack', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    const paid = harness.publisher.effects.find((effect) => effect.paid)
    harness.engine.onAckEffect(paid?.effectId as string, at(1_100))

    expect(harness.store.getEffect(paid?.effectId as string)?.ackedAt).toBe(at(1_100))
    expect(
      harness.store.listUnackedEffects().some((open) => open.effect.effectId === paid?.effectId),
    ).toBe(false)
  })
})
