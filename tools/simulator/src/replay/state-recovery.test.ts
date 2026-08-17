import { afterEach, describe, expect, it } from 'vitest'

import { parseScenario, scenarioIdentity, type Scenario } from '../scenario/index.js'
import { openSession, type SimulatorSession } from '../runner/session.js'

/**
 * Spec §11 "상태 복구":
 *
 * > backend, renderer, OBS를 각각 재시작해도 inbox의 미처리 `ingestSeq`, 마지막
 * > commit 상태와 deadline이 정의된 replay/coalesce/skip 규칙대로 복구된다.
 *
 * This file covers the backend restart, which is the one T11 is asked to prove
 * (renderer recovery from a snapshot alone is T5; OBS is T2/T12).
 *
 * The setup is deliberate: events are injected while the broadcast is degraded,
 * so they are *committed to the inbox but not yet processed* when the process
 * dies. That is the only interesting case — a restart after everything has been
 * drained proves nothing. After the restart the same rows must be drained in
 * `ingestSeq` order, the paid one exactly once, and the last committed state and
 * its deadlines must come back with it.
 */

let session: SimulatorSession | null = null

afterEach(async () => {
  await session?.close()
  session = null
})

/**
 * Four commands and a paid event arrive while the renderer is away, so the
 * writer holds them (spec §9.2). Nothing recovers them but the inbox.
 */
function unprocessedBacklogScenario(): Scenario {
  return parseScenario({
    id: 'restart-backlog',
    title: 'Backlog across a restart',
    summary: 'Events committed to the inbox but not yet processed when the backend goes down.',
    requiresVirtualClock: true,
    steps: [
      { kind: 'command', atMs: 0, command: 'FEED' },
      { kind: 'command', atMs: 500, command: 'PET' },
      { kind: 'command', atMs: 1_000, command: 'PLAY' },
      {
        kind: 'superChat',
        atMs: 1_500,
        amountMicros: 400_000,
        currency: 'JPY',
        tier: 1,
        messageId: 'msg_sim_restart_sc',
      },
      { kind: 'unsupported', atMs: 2_000, sourceMessageType: 'sponsorOnlyModeStartedEvent' },
      { kind: 'wait', atMs: 2_000, durationMs: 5_000 },
    ],
  })
}

describe('§11 상태 복구 — unprocessed ingestSeq after a backend restart', () => {
  it('drains the held inbox in ingestSeq order after the restart', async () => {
    const scenario = unprocessedBacklogScenario()
    // No renderer, so the writer is degraded and holds the rows (spec §9.2).
    session = await openSession({ attachRenderer: false })

    const result = await session.run(scenario)
    const beforeRestart = session.harness.engine.health()
    const held = session.harness.store.drainUnprocessed(0, 1_000)

    expect(result.inserted).toBe(result.envelopesPosted)
    expect(beforeRestart.processedIngestSeq).toBe(0)
    expect(held.map((row) => row.ingestSeq)).toEqual([1, 2, 3, 4, 5])

    // The backend goes down and comes back on the same database file. The
    // in-memory buffer is gone; only what was committed survives.
    await session.restart()
    await session.attachRenderer()

    const afterRestart = session.harness.engine.health()
    expect(session.harness.restartCount).toBe(1)
    // Spec §7.3(3): start-up drains everything after `processedIngestSeq`.
    expect(afterRestart.processedIngestSeq).toBe(result.envelopesPosted)
    expect(session.harness.store.drainUnprocessed(0, 1_000)).toEqual([])
    // The commands really were applied and not just marked done.
    const counters = session.harness.engine.metrics().counters
    expect(counters['command_direct']).toBe(3)
    expect(counters['envelope_unsupported']).toBe(1)
    expect(afterRestart.lastFailure).toBeNull()
  }, 60_000)

  it('applies a paid event held across the restart exactly once', async () => {
    const scenario = unprocessedBacklogScenario()
    session = await openSession({ attachRenderer: false })
    await session.run(scenario)

    const { broadcastId } = scenarioIdentity(scenario)
    const key = `simulator:${broadcastId}:msg_sim_restart_sc`
    // Not applied yet: the row is in the inbox, not in the audit ledger.
    expect(session.harness.store.hasPaidLedgerEntry(key)).toBe(false)

    await session.restart()
    await session.attachRenderer()

    expect(session.harness.store.hasPaidLedgerEntry(key)).toBe(true)
    expect(session.harness.store.countRows('paid_ledger')).toBe(1)

    // A second restart must not replay it: the ledger is the durable idempotency
    // unit (spec §11 유료 무결성 + 상태 복구 together).
    await session.restart()
    session.harness.engine.pump()
    expect(session.harness.store.countRows('paid_ledger')).toBe(1)
    expect(session.harness.restartCount).toBe(2)
  }, 60_000)

  it('restores the committed state revision and its pending deadlines', async () => {
    const scenario = unprocessedBacklogScenario()
    session = await openSession()

    await session.run(scenario)
    const before = session.harness.engine.health()
    const beforeSnapshot = session.harness.engine.snapshot()
    const beforeDeadlines = session.harness.store.listPendingDeadlines()
    expect(beforeDeadlines.length).toBeGreaterThan(0)

    await session.restart()

    const after = session.harness.engine.health()
    const afterSnapshot = session.harness.engine.snapshot()
    // The revision continues; it never restarts at zero (spec §10.2).
    expect(after.stateRevision).toBeGreaterThanOrEqual(before.stateRevision)
    expect(afterSnapshot.creature.creatureId).toBe(beforeSnapshot.creature.creatureId)
    expect(afterSnapshot.worldTimeUtc).toBe(beforeSnapshot.worldTimeUtc)
    // The timers came back with it: the world keeps moving after a restart
    // (spec §2.1, §10.2 replay/coalesce/skip).
    expect(session.harness.store.listPendingDeadlines().length).toBeGreaterThan(0)
  }, 60_000)
})
