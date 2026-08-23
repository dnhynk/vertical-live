import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  at,
  commandEnvelope,
  createEngineHarness,
  ingest,
  invalidEnvelope,
  resetMessageIds,
  testEngineConfig,
  unsupportedEnvelope,
  type EngineHarness,
} from './testing/harness.js'

/**
 * The writer loop of spec §7.3(3)(5): start-up order, the merge of inbox rows
 * and timers, and the rule that every row leaves the inbox with a recorded
 * reason — including the rows the world never sees.
 */

describe('StateEngine', () => {
  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness()
  })

  afterEach(() => {
    harness.dispose()
  })

  it('cold-starts a world and publishes a snapshot before it is ready', () => {
    harness.engine.start()

    expect(harness.engine.ready).toBe(true)
    const snapshot = harness.publisher.lastSnapshot
    expect(snapshot).toBeDefined()
    const published = snapshot as NonNullable<typeof snapshot>
    expect(published.stateRevision).toBeGreaterThan(0)
    expect(published.creature.creatureId).toBe(testEngineConfig().engine.creatureId)
    // Spec §2.1: content is already scheduled with no viewer and no input.
    expect(Date.parse(published.nextTransitionAt)).toBeGreaterThan(
      Date.parse(published.worldTimeUtc),
    )
  })

  it('applies a free command and advances the recovery cursor', async () => {
    harness.engine.start()
    ingest(harness.engine, [commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })])
    await harness.clock.advance(1_000)

    harness.engine.runPending()

    const snapshot = harness.publisher.lastSnapshot
    expect(snapshot?.display.lastAppliedAction).toEqual({
      commandName: 'FEED',
      appliedAt: at(1_000),
      contributionCount: 1,
    })
    expect(snapshot?.processedIngestSeq).toBe(1)
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('advances invalid and unsupported envelopes with a reason (spec §7.3(3))', async () => {
    harness.engine.start()
    ingest(harness.engine, [
      invalidEnvelope({ receivedAt: at(1_000) }),
      unsupportedEnvelope({ receivedAt: at(1_100) }),
      commandEnvelope({ command: 'PET', receivedAt: at(1_200) }),
    ])
    await harness.clock.advance(2_000)

    harness.engine.runPending()

    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
    expect(harness.engine.health().processedIngestSeq).toBe(3)
    const counters = harness.engine.metrics().counters
    expect(counters['envelope_invalid']).toBe(1)
    expect(counters['envelope_unsupported']).toBe(1)
    expect(counters['command_direct']).toBe(1)
  })

  // T41. The engine used to drop these into a `/metrics` counter nothing read,
  // which is how T40 discarded every arriving message for hours while all six
  // required families reported `ok`.
  it('reports a contract validation failure on /health and in the log', async () => {
    const warn = vi.fn()
    const logged = createEngineHarness({
      clock: harness.clock,
      temp: harness.temp,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    })
    logged.engine.start()
    ingest(logged.engine, [
      invalidEnvelope({ receivedAt: at(1_000) }),
      invalidEnvelope({ receivedAt: at(1_100) }),
    ])
    await harness.clock.advance(2_000)
    logged.engine.runPending()

    const rejected = logged.engine.health().ingestRejected
    expect(rejected.invalid.count).toBe(2)
    expect(rejected.invalid.byCode).toEqual({ MALFORMED_ITEM: 2 })
    expect(rejected.invalid.lastCode).toBe('MALFORMED_ITEM')
    expect(rejected.invalid.lastAt).not.toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith(
      'engine.envelope_invalid',
      expect.objectContaining({ code: 'MALFORMED_ITEM', totalInvalid: 2 }),
    )
    logged.engine.stop()
  })

  // The signal has to mean "our contract could not read the platform". Chat that
  // carries no command is the normal case (spec §7.3(3)) and a message type the
  // contract does not model is expected traffic; neither is a defect, so neither
  // may raise it or the signal is noise from the first hour of any run.
  it('does not raise it for ordinary chat or an unsupported message type', async () => {
    harness.engine.start()
    const noCommand = {
      ...commandEnvelope({ command: 'FEED', receivedAt: at(1_000) }),
      command: null,
    }
    ingest(harness.engine, [noCommand, unsupportedEnvelope({ receivedAt: at(1_100) })])
    await harness.clock.advance(2_000)
    harness.engine.runPending()

    const rejected = harness.engine.health().ingestRejected
    expect(rejected.invalid.count).toBe(0)
    expect(rejected.invalid.lastCode).toBeNull()
    expect(rejected.unsupported.count).toBe(1)
    expect(rejected.unsupported.lastAt).not.toBeNull()
  })

  it('records a chat message that carries no command as not a world input', async () => {
    harness.engine.start()
    const envelope = {
      ...commandEnvelope({ command: 'FEED', receivedAt: at(1_000) }),
      command: null,
    }
    ingest(harness.engine, [envelope])
    await harness.clock.advance(1_000)

    harness.engine.runPending()

    expect(harness.engine.metrics().counters['event_not_a_world_input']).toBe(1)
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('drops an argument outside the content vocabulary before it is stored', async () => {
    harness.engine.start()
    ingest(harness.engine, [
      commandEnvelope({ command: 'FEED', receivedAt: at(1_000), argument: 'not_a_choice' }),
    ])
    await harness.clock.advance(1_000)

    harness.engine.runPending()

    // Dropped at the storage boundary, so the writer never sees it at all
    // (`argument.test.ts` observes the row itself).
    expect(harness.engine.metrics().counters['ingest_argument_dropped']).toBe(1)
    expect(JSON.stringify(harness.publisher.effects)).not.toContain('not_a_choice')
  })

  it('keeps the world moving with no input at all (spec §2.1)', async () => {
    harness.engine.start()
    const startRevision = harness.engine.health().stateRevision

    await harness.clock.advance(20 * 60_000)
    harness.engine.runPending()

    expect(harness.engine.health().stateRevision).toBeGreaterThan(startRevision)
    expect(harness.publisher.effects.length).toBeGreaterThan(0)
  })

  it('writes one deadline row per (kind, key) and closes the ones that fired', async () => {
    harness.engine.start()
    const pendingAtStart = harness.store.listPendingDeadlines()
    expect(pendingAtStart.length).toBeGreaterThan(0)
    expect(new Set(pendingAtStart.map((row) => row.id)).size).toBe(pendingAtStart.length)

    await harness.clock.advance(10 * 60_000)
    harness.engine.runPending()

    const pending = harness.store.listPendingDeadlines()
    expect(pending.every((row) => row.dueAt > at(0))).toBe(true)
    for (const row of pending) {
      expect(['replay', 'coalesce', 'skip']).toContain(row.policy)
    }
  })

  it('is idle when nothing is due', async () => {
    harness.engine.start()
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    const revision = harness.engine.health().stateRevision

    expect(harness.engine.runPending()).toBe(0)
    expect(harness.engine.health().stateRevision).toBe(revision)
  })
})
