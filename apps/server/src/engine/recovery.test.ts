import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Effect, WorldSnapshot } from '@vl/contract'

import { makeSnapshot } from '../db/testing/fixtures.js'
import { RecordingPublisher } from './testing/harness.js'
import {
  at,
  createEngineHarness,
  ingest,
  resetMessageIds,
  restartEngine,
  superChatEnvelope,
  type EngineHarness,
} from './testing/harness.js'

/**
 * Restart behaviour (TASK_SPECS §T8 acceptance 3, spec §7.3(3)(7), §11 상태 복구).
 *
 * The window that matters is between the commit and the publish: the world has
 * moved, the durable outbox row exists, and nothing has reached the renderer. A
 * restart must put that row back on the wire and hand the renderer a snapshot it
 * agrees with — the effect's revision is never ahead of the snapshot's.
 */

/** Dies exactly where a crash between commit and publish would. */
class CrashingPublisher extends RecordingPublisher {
  crash = false

  override publishSnapshot(snapshot: WorldSnapshot): void {
    if (this.crash) throw new Error('simulated process death before publish')
    super.publishSnapshot(snapshot)
  }

  override publishEffect(effect: Effect): void {
    if (this.crash) throw new Error('simulated process death before publish')
    super.publishEffect(effect)
  }
}

describe('restart recovery', () => {
  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
  })

  afterEach(() => {
    harness.dispose()
  })

  it('republishes an effect committed but never published', async () => {
    const publisher = new CrashingPublisher()
    harness = createEngineHarness({ publisher })
    harness.engine.start()

    publisher.crash = true
    ingest(harness.engine, [
      superChatEnvelope({ messageId: 'msg_test_crash', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    expect(() => harness.engine.runPending()).toThrow(/simulated process death/)

    // Committed, durable, and invisible: exactly the crash window of §7.3(6).
    const openBefore = harness.store.listUnackedEffects()
    const paidRow = openBefore.find((open) => open.effect.paid)
    expect(paidRow).toBeDefined()
    expect(paidRow?.publishedAt).toBeNull()

    const restarted = restartEngine(harness)
    restarted.engine.start()

    const republished = restarted.publisher.effects.filter(
      (effect) => effect.effectId === paidRow?.effect.effectId,
    )
    expect(republished).toHaveLength(1)
    expect(
      restarted.store.getEffect(paidRow?.effect.effectId as string)?.publishedAt,
    ).not.toBeNull()

    // The renderer's view is coherent: the snapshot it gets is at least as new
    // as the effect it is being asked to play.
    const snapshot = restarted.publisher.lastSnapshot
    expect(snapshot?.stateRevision).toBeGreaterThanOrEqual(republished[0]?.stateRevision as number)
    expect(restarted.store.listUnackedEffects()).toHaveLength(openBefore.length)
    restarted.engine.stop()
  })

  it('replays every open effect to a renderer that says hello', async () => {
    harness = createEngineHarness()
    harness.engine.start()
    ingest(harness.engine, [
      superChatEnvelope({ messageId: 'msg_test_hello', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    const open = harness.store.listUnackedEffects()
    expect(open.length).toBeGreaterThan(0)
    const before = harness.publisher.effects.length

    harness.engine.onRendererHello(null)

    expect(harness.publisher.effects.length).toBe(before + open.length)
    expect(harness.publisher.lastSnapshot?.stateRevision).toBe(
      harness.engine.health().stateRevision,
    )
  })

  it('records an effect whose window passed without an ACK as expired', async () => {
    harness = createEngineHarness()
    harness.engine.start()
    ingest(harness.engine, [
      superChatEnvelope({ messageId: 'msg_test_exp', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    const effect = harness.publisher.effects.find((it) => it.paid)
    expect(effect).toBeDefined()

    await harness.clock.advance(harness.config.engine.effects.expiryGraceMs + 60_000)
    harness.engine.runPending()

    expect(harness.store.getEffect(effect?.effectId as string)?.expiredAt).not.toBeNull()
    expect(
      harness.store.listUnackedEffects().some((open) => open.effect.effectId === effect?.effectId),
    ).toBe(false)
    expect(harness.engine.metrics().counters['effect_expired']).toBeGreaterThan(0)
  })

  it('starts a fresh world when the database holds no engine state', () => {
    harness = createEngineHarness()
    // A row written by a caller that owns no domain state (every pre-T8 commit).
    harness.store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 4, processedIngestSeq: 0 }),
      revision: 4,
      processedSeq: 0,
    })
    expect(harness.store.loadRecoveryState().engineState).toBeNull()

    harness.engine.start()

    expect(harness.engine.ready).toBe(true)
    // It resumes the revision line rather than rewriting history.
    expect(harness.engine.health().stateRevision).toBeGreaterThan(4)
    expect(harness.publisher.lastSnapshot?.creature.creatureId).toBe(
      harness.config.engine.creatureId,
    )
  })

  it('refuses to start on engine state written by another version', () => {
    harness = createEngineHarness()
    harness.store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 2, processedIngestSeq: 0 }),
      revision: 2,
      processedSeq: 0,
      engineState: { version: 99, world: {}, inputMode: 'direct' },
    })

    expect(() => harness.engine.start()).toThrow(/another engine version/)
  })
})
