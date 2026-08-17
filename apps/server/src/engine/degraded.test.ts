import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  at,
  commandEnvelope,
  createEngineHarness,
  ingest,
  resetMessageIds,
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

    ingest(harness.store, [
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

    ingest(harness.store, [
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

    ingest(harness.store, [
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

  it('does not stage a substitute once the renderer confirmed the original', async () => {
    harness.engine.start()
    ingest(harness.store, [
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
