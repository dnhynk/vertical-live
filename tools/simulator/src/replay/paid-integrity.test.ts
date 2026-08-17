import { effectiveGiftCount } from '@vl/contract'
import { RetentionSweeper, loadRetentionConfig } from '@vl/server'
import { afterEach, describe, expect, it } from 'vitest'

import {
  findBuiltinScenario,
  parseScenario,
  planScenario,
  scenarioIdentity,
  type Scenario,
} from '../scenario/index.js'
import { postEnvelopes } from '../runner/inject.js'
import { openSession, type SimulatorSession } from '../runner/session.js'
import { settle, waitFor } from './support.js'

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

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

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

/** Distinct paid effect ids the renderer was told to stage for one event key. */
function paidEffectIdsFor(active: SimulatorSession, eventKey: string): Set<string> {
  return new Set(
    (active.renderer?.effectFrames ?? [])
      .filter((effect) => effect.paid && effect.causedByEventKey === eventKey)
      .map((effect) => effect.effectId),
  )
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

  it('refuses a redelivery whose inbox row retention has already swept', async () => {
    // The second defence, exercised where it is the *only* one left.
    //
    // Under normal ingest the two defences are congruent: the inbox key is
    // `(source, broadcastId, messageId, giftEffectiveCount)` and the event key is
    // built from the same four values, so a redelivery never gets past the inbox
    // and the ledger guard is never asked (review round 1, M1 — the previous
    // version of this test asserted nothing for that reason).
    //
    // They come apart when the inbox row is deleted and the ledger row is not.
    // `config/retention.json` gives both 30 days but keys them on different
    // columns — the inbox on `received_at`, the ledger on `applied_at` — so an
    // event received while the broadcast was degraded and applied hours later
    // (spec §9.2: paid events are held, never dropped) leaves a window in which
    // the source row is gone and the audit row is still owed. A redelivery in
    // that window — spec §11 연결 복구 — creates a genuinely new inbox row, and
    // only `paid_ledger`'s primary key can stop a second audit staging.
    const scenario = parseScenario({
      id: 'paid-retention-replay',
      title: 'Paid redelivery after the inbox was swept',
      summary: 'One Super Chat, held while degraded, applied late, redelivered after retention.',
      steps: [
        {
          kind: 'superChat',
          atMs: 0,
          amountMicros: 500_000,
          currency: 'JPY',
          tier: 1,
          messageId: 'msg_sim_retention_sc',
        },
      ],
    })
    const plan = planScenario(scenario)
    const batch = plan.batches[0]
    if (batch === undefined) throw new Error('expected a batch')
    const key = keyOf(scenario, 'msg_sim_retention_sc')

    // No renderer: the writer is degraded and holds the row (spec §9.2).
    session = await openSession({ attachRenderer: false })
    const clock = session.clock
    if (clock === null) throw new Error('expected a virtual clock')
    const target = session.target

    const firstDelivery = await postEnvelopes(target, batch.build(clock.nowUtcIso()))
    expect(firstDelivery.status).toBe(202)
    expect(firstDelivery.inserted).toBe(1)

    // Held for two hours, then applied. `applied_at` is now two hours behind
    // `received_at`, which is the whole point of the window.
    await clock.advance(2 * HOUR_MS)
    await session.attachRenderer()
    session.harness.engine.pump()
    expect(session.harness.store.hasPaidLedgerEntry(key)).toBe(true)
    const ledgerRowsBefore = session.harness.store.countRows('paid_ledger')
    // The clock is virtual but the socket is real: the staging reaches the
    // renderer a few turns of the event loop after the commit, not inside it.
    const active = session
    await waitFor(() => paidEffectIdsFor(active, key).size > 0)
    const paidEffectsBefore = paidEffectIdsFor(session, key)
    // At least the original staging. A two-hour hold also outlives
    // `tuning.paid.originalStagingWindowMs`, so §9.2's substitute acknowledgement
    // may have staged as well — that rule is T8's, and what this test is about is
    // that the *redelivery* adds nothing to whatever is here.
    expect(paidEffectsBefore.size).toBeGreaterThan(0)

    // Move to `received_at + 30 days + 1 hour`. The sweep cutoff is then
    // `received_at + 1 hour`: past the inbox row's `received_at`, short of the
    // ledger row's `applied_at` two hours in. The engine is restarted rather than
    // pumped across the gap, which is what the §10.2 deadline policies are for.
    await clock.advance(30 * DAY_MS - HOUR_MS)
    await session.restart()

    const sweep = new RetentionSweeper({
      store: session.harness.store,
      clock: session.harness.clock,
      config: loadRetentionConfig({ env: {} }),
    }).run()
    const inbox = sweep.entries.find((entry) => entry.fieldKey === 'ingest_inbox.envelope')
    const ledger = sweep.entries.find((entry) => entry.fieldKey === 'paid_ledger.event_key')

    expect(inbox?.rowsDeleted).toBeGreaterThan(0)
    expect(ledger?.rowsDeleted).toBe(0)
    expect(session.harness.store.countRows('ingest_inbox')).toBe(0)
    expect(session.harness.store.hasPaidLedgerEntry(key)).toBe(true)

    // What the renderer attached after the restart has been told to stage for
    // this event so far. The redelivery may not add to it.
    const stagedSinceRestart = paidEffectIdsFor(session, key)

    // The redelivery, over the same HTTP endpoint as every other injection.
    const redelivery = await postEnvelopes(target, batch.build(clock.nowUtcIso()))

    // The assertion the previous version was missing: the row is genuinely new,
    // so the writer really does reach the ledger check.
    expect(redelivery.status).toBe(202)
    expect(redelivery.inserted).toBe(1)
    expect(redelivery.duplicates).toBe(0)
    expect(session.harness.store.countRows('ingest_inbox')).toBe(1)

    session.harness.engine.pump()
    // Long enough for a second staging to have arrived if one had been made:
    // the first one took a fraction of this.
    await settle()

    const counters = session.harness.engine.metrics().counters
    // `paid_duplicate` is incremented by the ledger guard and by nothing else,
    // which is what makes this line the discriminator. It is also the *only*
    // line that can be: `paid_ledger`'s insert is `ON CONFLICT DO NOTHING` and
    // the world keeps its own acknowledged ring, so the row count and the
    // staging below stay correct even with the guard gone — they are the
    // consequences being protected, not the proof that this defence ran.
    // Verified by removing the guard: this line failed with `undefined`
    // (round 1 fix, see the ticket's `## Review round 1`).
    expect(counters['paid_duplicate']).toBe(1)
    expect(counters['paid_applied'] ?? 0).toBe(0)
    expect(session.harness.store.countRows('paid_ledger')).toBe(ledgerRowsBefore)
    expect(paidEffectIdsFor(session, key)).toEqual(stagedSinceRestart)
  }, 120_000)
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
