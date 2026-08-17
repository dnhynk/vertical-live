import { effectiveGiftCount } from '@vl/contract'
import { afterEach, describe, expect, it } from 'vitest'

import { findBuiltinScenario, scenarioIdentity, type Scenario } from '../scenario/index.js'
import { openSession, type SimulatorSession } from '../runner/session.js'

/**
 * Spec §11 "유료 무결성":
 *
 * > replay에서 동일 Super Chat은 한 번만, Gift combo는 증가분만 한 번 반영되고
 * > 같은 paid `effectId`가 재전송돼도 연출을 재시작하지 않음.
 *
 * All three halves are asserted against a real backend driven over real HTTP by
 * the `paid-replay` scenario, not against a mock of one.
 *
 * There are two independent defences and the tests keep them apart, because they
 * fail differently. The inbox's unique key
 * `(source, broadcast_id, message_id, gift_effective_count)` (§T4) stops a
 * *redelivery* — the same message arriving again after a reconnect. The paid
 * ledger's primary key and the non-decreasing gift maximum (§T8) stop a *replay
 * of an already-applied event*, which is what survives a restart and a ring
 * eviction. A test that only exercised the first would pass with the second
 * removed.
 */

/**
 * Distinct paid event keys in `paid-replay`: the Super Chat, the Super Sticker,
 * the three gift steps that advanced the maximum (`:gift:1`, `:gift:3`,
 * `:gift:5`) and the two memberships. The redelivered Super Chat, the repeated
 * combo step and the backwards combo step add none.
 */
const APPLIED_PAID_EVENTS = 7

let session: SimulatorSession | null = null

afterEach(async () => {
  await session?.close()
  session = null
})

function paidScenario(): Scenario {
  const scenario = findBuiltinScenario('paid-replay')
  if (scenario === null) throw new Error('missing built-in scenario paid-replay')
  return scenario
}

function keyOf(scenario: Scenario, messageId: string, giftCount?: number): string {
  const { broadcastId } = scenarioIdentity(scenario)
  const base = `simulator:${broadcastId}:${messageId}`
  return giftCount === undefined ? base : `${base}:gift:${String(giftCount)}`
}

describe('§11 유료 무결성 — same Super Chat once', () => {
  it('applies a redelivered Super Chat exactly once, on the wire and in the ledger', async () => {
    const scenario = paidScenario()
    session = await openSession()

    const result = await session.run(scenario)
    const key = keyOf(scenario, 'msg_sim_paid_sc_a')
    const effects = (session.renderer?.effectFrames ?? []).filter(
      (effect) => effect.causedByEventKey === key,
    )

    // The scenario delivered it twice.
    expect(result.duplicates).toBeGreaterThan(0)
    // The ledger holds it once (its primary key is the event key, §T4).
    expect(session.harness.store.hasPaidLedgerEntry(key)).toBe(true)
    expect(session.harness.store.countRows('paid_ledger')).toBe(APPLIED_PAID_EVENTS)
    // And exactly one staging reached the renderer for it (spec §8.4).
    expect(new Set(effects.map((effect) => effect.effectId)).size).toBe(1)
    expect(effects.every((effect) => effect.paid)).toBe(true)
  }, 60_000)
})

describe('§11 유료 무결성 — gift combo delta only', () => {
  it('advances the stored maximum and never re-applies or decreases it', async () => {
    const scenario = paidScenario()
    session = await openSession()

    await session.run(scenario)
    const store = session.harness.store
    const base = keyOf(scenario, 'msg_sim_paid_gift_a')
    const counters = session.harness.engine.metrics().counters

    // The scenario walks comboCount 0 → 3 → 3 → 5 → 2 (spec §7.4:
    // effectiveCount = comboCount > 0 ? comboCount : 1).
    expect(effectiveGiftCount(0)).toBe(1)
    expect(store.getGiftStoredMax(base)).toBe(5)
    // One ledger row per step that actually added something.
    expect(store.hasPaidLedgerEntry(`${base}:gift:1`)).toBe(true)
    expect(store.hasPaidLedgerEntry(`${base}:gift:3`)).toBe(true)
    expect(store.hasPaidLedgerEntry(`${base}:gift:5`)).toBe(true)
    // The backwards step reached the writer (its inbox key is distinct) and was
    // refused there: `storedMax` does not decrease.
    expect(store.hasPaidLedgerEntry(`${base}:gift:2`)).toBe(false)
    expect(counters['gift_no_delta']).toBeGreaterThan(0)
  }, 60_000)

  it('refuses an already-applied paid event when it reaches the writer a second time', async () => {
    // The second defence, exercised on its own: the same event key is offered to
    // the writer again through a *different* inbox row, which is what a ring
    // eviction or a rebuilt in-memory audit would produce. Only the paid
    // ledger's primary key can catch this one (spec §11, §T8 idempotency 1).
    const scenario = paidScenario()
    session = await openSession()
    await session.run(scenario)

    const key = keyOf(scenario, 'msg_sim_paid_sc_a')
    const ledgerRowsBefore = session.harness.store.countRows('paid_ledger')
    expect(session.harness.store.hasPaidLedgerEntry(key)).toBe(true)

    const { broadcastId, liveChatId } = scenarioIdentity(scenario)
    const engine = session.harness.engine
    engine.ingest(
      [
        {
          schemaVersion: 1,
          sourceShape: 'simulator',
          source: 'simulator',
          broadcastId,
          liveChatId,
          // A different message id would be a different event; this row carries
          // the *same* one, arriving on a fresh gift-count slot so the inbox
          // accepts it and the ledger has to be the thing that says no.
          messageId: 'msg_sim_paid_sc_a',
          receivedAt: session.harness.clock.nowUtcIso(),
          validationStatus: 'valid',
          kind: 'SUPER_CHAT',
          occurredAt: session.harness.clock.nowUtcIso(),
          command: null,
          payment: {
            amountMicros: 500_000,
            currency: 'JPY',
            tier: 1,
            jewels: null,
            comboCount: null,
            giftName: null,
          },
        },
      ],
      { sourceKey: `simulator:${liveChatId}`, liveChatId, nextPageToken: null },
    )
    engine.pump()

    expect(session.harness.store.countRows('paid_ledger')).toBe(ledgerRowsBefore)
  }, 60_000)
})

describe('§11 유료 무결성 — a retransmitted paid effect does not restart', () => {
  it('resends the same effectId and the renderer starts it once', async () => {
    const scenario = paidScenario()
    // The renderer receives effects and does not acknowledge them, so the engine
    // keeps retransmitting the open ones (spec §7.3(7)).
    session = await openSession({ rendererAckEffects: false, sliceMs: 1_000 })

    await session.run(scenario)
    const renderer = session.renderer
    if (renderer === null) throw new Error('expected an attached renderer')
    const paidFrames = renderer.effectFrames.filter((effect) => effect.paid)
    const distinctPaid = new Set(paidFrames.map((effect) => effect.effectId))

    // It really was retransmitted…
    expect(paidFrames.length).toBeGreaterThan(distinctPaid.size)
    expect(renderer.repeatedEffectFrames).toBeGreaterThan(0)
    const counters = session.harness.engine.metrics().counters
    expect(counters['effect_retransmitted']).toBeGreaterThan(0)
    // …and a repeat never counted as a new staging: the renderer started exactly
    // as many as the writer committed, however many frames carried them
    // (spec §7.3(7)).
    expect(renderer.effectStarts).toBe(counters['effect_published'])
    expect(renderer.effectFrames.length).toBeGreaterThan(renderer.effectStarts)
  }, 60_000)
})
