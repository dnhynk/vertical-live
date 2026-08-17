import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Effect } from '@vl/contract'

import {
  at,
  commandEnvelope,
  createEngineHarness,
  ingest,
  resetMessageIds,
  restartEngine,
  superChatEnvelope,
  type EngineHarness,
} from './testing/harness.js'

/**
 * Degraded windows (TASK_SPECS §T8 acceptance 4, spec §9.2).
 *
 * Three rules, tested as three separate claims:
 *
 * 1. the CTA is switched off in the published read model, not merely in the UI;
 * 2. an event received while degraded is preserved and applied on recovery —
 *    and recorded `expired` once its pre-approved validity has passed;
 * 3. a paid event whose original staging window has gone gets exactly one
 *    substitute acknowledgement, and none at all if the renderer confirmed the
 *    original.
 */

/** The substitute acknowledgements among published effects (spec §9.2). */
function fallbackStagings(effects: readonly Effect[]): Effect[] {
  return effects.filter((effect) => effect.kind === 'PAID_THANKS' && effect.payload.fallback)
}

describe('degraded window', () => {
  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness()
  })

  afterEach(() => {
    harness.dispose()
  })

  it('publishes interactionEnabled=false when no renderer is attached', async () => {
    harness.engine.start()
    expect(harness.publisher.lastSnapshot?.interactionEnabled).toBe(true)

    harness.publisher.rendererCount = 0
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    const snapshot = harness.publisher.lastSnapshot
    expect(snapshot?.interactionEnabled).toBe(false)
    expect(snapshot?.broadcastLifecycle).toBe('degraded')
    expect(harness.engine.health().degradedReasons).toContain('no_renderer')
  })

  it('publishes interactionEnabled=false when the input path reports unhealthy', async () => {
    harness.engine.start()

    harness.engine.reportInputHealth('degraded')
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    expect(harness.publisher.lastSnapshot?.interactionEnabled).toBe(false)
    expect(harness.engine.health().degradedReasons).toContain('input_degraded')
  })

  it('preserves events received while degraded and applies them on recovery', async () => {
    harness.engine.start()
    harness.engine.reportInputHealth('degraded')
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    ingest(harness.engine, [
      commandEnvelope({ messageId: 'msg_test_deg', command: 'FEED', receivedAt: at(2_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    // Held, not lost and not shown as applied (spec §9.2).
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(1)
    expect(harness.publisher.lastSnapshot?.display.lastAppliedAction).toBeNull()

    harness.engine.reportInputHealth('ok')
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
    expect(harness.publisher.lastSnapshot?.display.lastAppliedAction?.commandName).toBe('FEED')
    expect(harness.publisher.lastSnapshot?.interactionEnabled).toBe(true)
  })

  it('records a command whose validity passed as expired instead of applying it', async () => {
    harness.engine.start()
    harness.engine.reportInputHealth('degraded')
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    ingest(harness.engine, [
      commandEnvelope({ messageId: 'msg_test_stale', command: 'PLAY', receivedAt: at(2_000) }),
    ])
    await harness.clock.advance(harness.config.engine.degraded.eventValidityMs + 60_000)
    harness.engine.runPending()
    harness.engine.reportInputHealth('ok')
    harness.engine.runPending()

    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
    expect(harness.engine.metrics().counters['event_expired']).toBe(1)
    expect(harness.engine.metrics().counters['command_direct']).toBeUndefined()
    expect(harness.publisher.lastSnapshot?.display.lastAppliedAction).toBeNull()
  })

  it('never expires a paid event and stages one substitute acknowledgement', async () => {
    harness.engine.start()
    harness.engine.reportInputHealth('degraded')
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    ingest(harness.engine, [
      superChatEnvelope({ messageId: 'msg_test_paid_deg', receivedAt: at(2_000) }),
    ])
    // Longer than the original staging window, shorter than the free-command
    // validity: the acknowledgement is owed, the substitute is what runs.
    await harness.clock.advance(harness.config.tuning.paid.originalStagingWindowMs + 60_000)
    harness.engine.runPending()
    harness.engine.reportInputHealth('ok')
    harness.engine.runPending()

    const paid = harness.publisher.effects.filter((effect) => effect.paid)
    const distinct = new Map(paid.map((effect) => [effect.effectId, effect]))
    expect(distinct.size).toBe(1)
    const only = [...distinct.values()][0]
    expect(only?.payload).toMatchObject({ fallback: true, paidEventKind: 'SUPER_CHAT' })
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('does not stage a substitute after a restart between the ACK and the commit', async () => {
    // The R-T8-1 blocker 2 reproduction: `acked_at` is written immediately but the
    // world's obligation is cleared by the next commit, and the process dies in
    // between. The durable ACK — not the in-memory queue — has to decide.
    harness.engine.start()
    ingest(harness.engine, [
      superChatEnvelope({ messageId: 'msg_test_ack_crash', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    const original = harness.publisher.effects.find((effect) => effect.paid)
    expect(original?.payload).toMatchObject({ fallback: false })

    harness.engine.onAckEffect(original?.effectId as string, at(1_100))
    // No pass runs: the obligation is still in the persisted state.
    const restarted = restartEngine(harness)
    restarted.engine.start()
    await restarted.clock.advance(restarted.config.tuning.paid.originalStagingWindowMs + 60_000)
    restarted.engine.runPending()

    expect(fallbackStagings(restarted.publisher.effects)).toHaveLength(0)
    expect(restarted.engine.metrics().counters['paid_fallback_settled_by_ack']).toBe(1)
    // The obligation is gone for good, so a later pass cannot revive it either.
    await restarted.clock.advance(60_000)
    restarted.engine.runPending()
    expect(fallbackStagings(restarted.publisher.effects)).toHaveLength(0)
    restarted.engine.stop()
  })

  it('closes the substitute obligation when the ACK precedes the window', async () => {
    harness.engine.start()
    ingest(harness.engine, [
      superChatEnvelope({ messageId: 'msg_test_ack_race', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    const original = harness.publisher.effects.find((effect) => effect.paid)
    expect(
      harness.store.listPendingDeadlines().some((row) => row.kind === 'paid_thanks_fallback'),
    ).toBe(true)

    // ACK, then jump straight past the substitute window without a pass between.
    harness.engine.onAckEffect(original?.effectId as string, at(1_100))
    await harness.clock.advance(harness.config.tuning.paid.originalStagingWindowMs + 60_000)
    harness.engine.runPending()

    expect(fallbackStagings(harness.publisher.effects)).toHaveLength(0)
    // The obligation is closed in the store as well as in memory, whichever of
    // the two paths got there first (the queued clear, or the durable ACK check).
    expect(
      harness.store.listPendingDeadlines().some((row) => row.kind === 'paid_thanks_fallback'),
    ).toBe(false)
  })

  it('does not stage a substitute once the renderer confirmed the original', async () => {
    harness.engine.start()
    ingest(harness.engine, [
      superChatEnvelope({ messageId: 'msg_test_paid_ok', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    const original = harness.publisher.effects.find((effect) => effect.paid)
    expect(original?.payload).toMatchObject({ fallback: false })
    harness.engine.onAckEffect(original?.effectId as string, at(1_100))
    harness.engine.runPending()

    await harness.clock.advance(harness.config.tuning.paid.originalStagingWindowMs + 60_000)
    harness.engine.runPending()

    const paidIds = new Set(
      harness.publisher.effects.filter((effect) => effect.paid).map((effect) => effect.effectId),
    )
    expect(paidIds).toEqual(new Set([original?.effectId]))
  })
})
