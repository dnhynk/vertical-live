import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IngestEnvelope } from '@vl/contract'

import {
  at,
  commandEnvelope,
  createEngineHarness,
  ingest,
  resetMessageIds,
  restartEngine,
  testInputConfig,
  type EngineHarness,
} from './testing/harness.js'

/**
 * Flood handling (spec §6.4, §7.3, TASK_SPECS §T8 arbiter payload note).
 *
 * The split the arbiter reports is the whole point: `directApplied` was already
 * acted on as it arrived, `aggregatedOnly` was not. Applying the sum would
 * double-count and skipping it would lose contributions, so the engine applies
 * exactly `aggregatedOnly` — once, when the window closes, carried by the last
 * real event of that command. No synthetic event is invented (spec §2.6).
 *
 * The other half is durability: a held command is *not* recorded as processed,
 * so the recovery cursor stays below it and a restart re-drains it.
 */

function floodEnvelopes(count: number, command: 'FEED' | 'PLAY' = 'FEED'): IngestEnvelope[] {
  return Array.from({ length: count }, (_, index) =>
    commandEnvelope({
      messageId: `msg_test_flood_${command}_${String(index).padStart(3, '0')}`,
      command,
      receivedAt: at(1_000 + index),
    }),
  )
}

describe('aggregate windows', () => {
  let harness: EngineHarness
  const window = testInputConfig().window

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness()
  })

  afterEach(() => {
    harness.dispose()
  })

  it('holds the overflow of a window and applies it once the window closes', async () => {
    harness.engine.start()
    const overflow = 5
    ingest(harness.store, floodEnvelopes(window.maxDirectPerWindow + overflow))
    await harness.clock.advance(1_000)

    harness.engine.runPending()

    const counters = harness.engine.metrics().counters
    expect(counters['command_direct']).toBe(window.maxDirectPerWindow)
    expect(counters['command_aggregated']).toBe(overflow)
    // The cursor stops below the held rows: they are still unprocessed.
    expect(harness.store.drainUnprocessed(0, 100)).toHaveLength(overflow)
    expect(harness.engine.health().processedIngestSeq).toBe(window.maxDirectPerWindow)

    await harness.clock.advance(window.windowMs + 1_000)
    harness.engine.runPending()

    expect(harness.store.drainUnprocessed(0, 100)).toHaveLength(0)
    expect(harness.engine.health().processedIngestSeq).toBe(window.maxDirectPerWindow + overflow)
    expect(harness.engine.metrics().counters['aggregate_window_closed']).toBeGreaterThan(0)
    const aggregated = harness.publisher.effects.filter(
      (effect) =>
        effect.kind === 'ACTION_REACTION' && effect.payload.contributionCount === overflow,
    )
    expect(aggregated).toHaveLength(1)
    // Carried by a real message, not by an invented one (spec §2.6).
    expect(aggregated[0]?.causedByEventKey).toMatch(/^simulator:brd_test_engine:msg_test_flood_/)
  })

  it('switches the next window to aggregate mode and shows it on screen', async () => {
    harness.engine.start()
    ingest(harness.store, floodEnvelopes(window.enterAggregateAtCommands))
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    await harness.clock.advance(window.windowMs + 1_000)
    harness.engine.runPending()

    expect(harness.engine.health().inputMode).toBe('aggregate')
    ingest(harness.store, floodEnvelopes(2, 'PLAY'))
    await harness.clock.advance(100)
    harness.engine.runPending()

    const snapshot = harness.publisher.lastSnapshot
    expect(snapshot?.inputMode).toBe('aggregate')
    expect(snapshot?.display.aggregateWindow?.mode).toBe('aggregate')
    // Nothing was applied individually in aggregate mode.
    expect(harness.store.drainUnprocessed(0, 100)).toHaveLength(2)
  })

  it('re-drains held commands after a restart instead of losing them', async () => {
    harness.engine.start()
    const overflow = 3
    ingest(harness.store, floodEnvelopes(window.maxDirectPerWindow + overflow))
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    expect(harness.store.drainUnprocessed(0, 100)).toHaveLength(overflow)

    const restarted = restartEngine(harness)
    restarted.engine.start()

    // The restart drains them as ordinary direct commands: the window they
    // belonged to died with the process, and the contributions did not.
    expect(restarted.store.drainUnprocessed(0, 100)).toHaveLength(0)
    expect(restarted.engine.health().processedIngestSeq).toBe(window.maxDirectPerWindow + overflow)
    restarted.engine.stop()
  })

  it('preserves every contribution across the direct/aggregated split', async () => {
    harness.engine.start()
    const total = window.maxDirectPerWindow + 4
    ingest(harness.store, floodEnvelopes(total))
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    await harness.clock.advance(window.windowMs + 1_000)
    harness.engine.runPending()

    // By effect id: a retransmission is the same staging, not a new one.
    const distinct = new Map(
      harness.publisher.effects
        .filter((effect) => effect.kind === 'ACTION_REACTION')
        .map((effect) => [effect.effectId, effect.payload.contributionCount as number]),
    )
    const applied = [...distinct.values()].reduce((sum, count) => sum + count, 0)
    expect(applied).toBe(total)
  })
})
