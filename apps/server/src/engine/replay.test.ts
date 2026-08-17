import { afterEach, describe, expect, it } from 'vitest'

import type { IngestEnvelope, WorldSnapshot } from '@vl/contract'

import { FakeClock } from '../testing/fake-clock.js'
import {
  TEST_EPOCH_MS,
  at,
  commandEnvelope,
  createEngineHarness,
  giftEnvelope,
  ingest,
  invalidEnvelope,
  resetMessageIds,
  superChatEnvelope,
  type EngineHarness,
} from './testing/harness.js'

/**
 * Replay determinism (TASK_SPECS §T8 acceptance 1).
 *
 * The claim under test is exactly this: **the same inbox, the same seed and the
 * same clock produce the same snapshot and the same revision.** All three are
 * injected — the seed from `config/default.json`, the clock per spec §10.2 — so
 * the property is a statement about the engine and not about the machine it ran
 * on. Anything that read `Date.now()` or an unseeded generator would break it.
 */

/** A fixed, obviously synthetic inbox: commands, a paid event, a bad item. */
function scenarioEnvelopes(): IngestEnvelope[] {
  return [
    commandEnvelope({ messageId: 'msg_test_r1', command: 'FEED', receivedAt: at(1_000) }),
    invalidEnvelope({ messageId: 'msg_test_r2', receivedAt: at(1_500) }),
    commandEnvelope({ messageId: 'msg_test_r3', command: 'PLAY', receivedAt: at(2_000) }),
    superChatEnvelope({ messageId: 'msg_test_r4', receivedAt: at(2_500) }),
    giftEnvelope({ messageId: 'msg_test_r5', comboCount: 2, receivedAt: at(3_000) }),
    commandEnvelope({ messageId: 'msg_test_r6', command: 'PET', receivedAt: at(4_000) }),
  ]
}

interface RunResult {
  readonly snapshot: WorldSnapshot
  readonly revision: number
  readonly effectIds: readonly string[]
  readonly effectCauses: readonly (string | null)[]
}

async function runScenario(harness: EngineHarness): Promise<RunResult> {
  harness.engine.start()
  ingest(harness.store, scenarioEnvelopes())
  // A fixed schedule: the same steps in the same order in both runs.
  for (const stepMs of [1_000, 1_000, 1_000, 1_000, 5 * 60_000, 10 * 60_000]) {
    await harness.clock.advance(stepMs)
    harness.engine.runPending()
  }
  return {
    snapshot: harness.engine.snapshot(),
    revision: harness.engine.health().stateRevision,
    effectIds: harness.publisher.effects.map((effect) => effect.effectId),
    effectCauses: harness.publisher.effects.map((effect) => effect.causedByEventKey),
  }
}

describe('replay determinism', () => {
  const harnesses: EngineHarness[] = []

  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.dispose()
  })

  function freshHarness(): EngineHarness {
    resetMessageIds()
    const harness = createEngineHarness({ clock: new FakeClock({ epochMs: TEST_EPOCH_MS }) })
    harnesses.push(harness)
    return harness
  }

  it('two boots over the same inbox reach the same snapshot and revision', async () => {
    const first = await runScenario(freshHarness())
    const second = await runScenario(freshHarness())

    expect(second.revision).toBe(first.revision)
    expect(second.snapshot).toEqual(first.snapshot)
    expect(second.effectIds).toEqual(first.effectIds)
    expect(second.effectCauses).toEqual(first.effectCauses)
  })

  it('produces effect ids derived from the revision, not from a random source', async () => {
    const result = await runScenario(freshHarness())

    expect(result.effectIds.length).toBeGreaterThan(0)
    for (const effectId of result.effectIds) {
      expect(effectId).toMatch(/^e\d+_\d+$/)
    }
    // An id repeats only as a retransmission of the *same* effect: two different
    // stagings sharing an id would make the renderer's dedupe drop one of them.
    const byId = new Map<string, string>()
    for (const effect of harnesses[0]?.publisher.effects ?? []) {
      const serialized = JSON.stringify(effect)
      const previous = byId.get(effect.effectId)
      if (previous === undefined) byId.set(effect.effectId, serialized)
      else expect(serialized).toBe(previous)
    }
  })

  it('restarting on the same database resumes instead of restarting the world', async () => {
    const harness = freshHarness()
    const before = await runScenario(harness)

    harness.engine.stop()
    harness.temp.reopen()
    const resumed = createEngineHarness({ temp: harness.temp, clock: harness.clock })
    harnesses.push(resumed)
    resumed.engine.start()

    const after = resumed.engine.snapshot()
    // The creature keeps its history: nothing was re-applied and nothing reset.
    expect(after.creature.bondProgress).toEqual(before.snapshot.creature.bondProgress)
    expect(after.creature.growthProgress).toEqual(before.snapshot.creature.growthProgress)
    expect(after.processedIngestSeq).toBe(before.snapshot.processedIngestSeq)
    expect(after.stateRevision).toBeGreaterThanOrEqual(before.revision)
    expect(resumed.store.drainUnprocessed(0, 20)).toHaveLength(0)
  })
})
