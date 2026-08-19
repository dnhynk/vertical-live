import type { Effect } from '@vl/contract'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import type { PersistenceStore } from '../db/store.js'
import {
  at,
  createEngineHarness,
  ingest,
  resetMessageIds,
  restartEngine,
  superChatEnvelope,
  withEngineConfig,
} from './testing/harness.js'

/**
 * A forward jump in world time is downtime, not a backlog (T8e, observed in the
 * T20b review).
 *
 * The writer loop merges due deadlines one at a time and commits each one, which
 * is right at the engine's own pace — a 250ms tick against a 30s idle beat. It
 * was also what a jump did: `pump()` after a 31-day jump walked 88,479
 * occurrences and took 266s on the T8e host, so a suspended laptop or a
 * corrected clock wedged the single writer for minutes. Spec §10.2 already says
 * what happens to timers a downtime missed, and `start()` already applies it;
 * these tests pin that the running loop applies it too.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Takes the database's write lock just before the recovery transition is
 * written, so that one commit — and only that one — ends in `SQLITE_BUSY` once
 * `busy_timeout` elapses (review round 1, B1).
 *
 * Only the moment is arranged: the store, the transaction and the error are
 * real, and a backup or an antivirus scan holding the file under a live
 * broadcast lands in exactly this window (spec §11 fault matrix "DB lock").
 */
function lockOnDeadlineRecovery(store: PersistenceStore, competitor: Database.Database): void {
  const commit = store.commitStateTransition.bind(store)
  store.commitStateTransition = (input) => {
    if ((input.transitions ?? []).some((transition) => transition.kind === 'deadline_recovery')) {
      store.commitStateTransition = commit
      competitor.exec('BEGIN IMMEDIATE')
    }
    return commit(input)
  }
}

/** The substitute acknowledgements among published effects (spec §9.2). */
function fallbackStagings(effects: readonly Effect[]): Effect[] {
  return effects.filter((effect) => effect.kind === 'PAID_THANKS' && effect.payload.fallback)
}

describe('writer pass after a virtual clock jump', () => {
  it('returns after a 31-day jump without walking the gap occurrence by occurrence', () => {
    const harness = createEngineHarness()
    harness.engine.start()
    const before = harness.engine.health().stateRevision

    harness.clock.advance(31 * DAY_MS)
    const startedAt = process.hrtime.bigint()
    const commits = harness.engine.pump()
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

    // The bound is the point of the test: the gap is 31 days of seconds-scale
    // timers, so a pass that still walked it would be in the tens of thousands.
    // 200 is far above what the policies produce and far below the walk.
    expect(commits).toBeLessThan(200)
    expect(elapsedMs).toBeLessThan(10_000)
    // It is a catch-up, not a no-op: the world moved and said so.
    expect(harness.engine.health().stateRevision).toBeGreaterThan(before)
    // And the count is the pass's real one. Every `commitStateTransition` takes
    // exactly one revision, including the recovery's own — a return value that
    // left the recovery's commits out would be a bound on the wrong number
    // (review round 1, M1).
    expect(commits).toBe(harness.engine.health().stateRevision - before)
    expect(harness.engine.metrics().counters['deadline_gap_recovered']).toBe(1)
    // No failure was swallowed by `pump()`.
    expect(harness.engine.health().lastFailure).toBeNull()

    harness.dispose()
  })

  it('leaves a gap inside the catch-up window to the ordinary loop', () => {
    const harness = createEngineHarness()
    harness.engine.start()

    // Just under `engine.deadlines.catchUpWindowMs`: this is the engine running
    // late, not the world being down, so nothing is skipped or coalesced.
    harness.clock.advance(harness.config.engine.deadlines.catchUpWindowMs - 60_000)
    const commits = harness.engine.pump()

    expect(commits).toBeGreaterThan(0)
    expect(harness.engine.metrics().counters['deadline_gap_recovered']).toBeUndefined()

    harness.dispose()
  })

  it('recovers once per pass, and the next pass has nothing overdue left', () => {
    const harness = createEngineHarness()
    harness.engine.start()

    harness.clock.advance(31 * DAY_MS)
    harness.engine.pump()
    const afterFirst = harness.engine.health().stateRevision

    // A second pass at the same instant: everything the first one re-armed is in
    // the future, so there is nothing to recover and nothing to walk.
    const commits = harness.engine.pump()

    expect(commits).toBe(0)
    expect(harness.engine.health().stateRevision).toBe(afterFirst)
    expect(harness.engine.metrics().counters['deadline_gap_recovered']).toBe(1)

    harness.dispose()
  })

  it('honours a configured catch-up window', () => {
    const config = withEngineConfig((base) => ({
      ...base,
      engine: { ...base.engine, deadlines: { catchUpWindowMs: 5 * 60_000 } },
    }))
    const harness = createEngineHarness({ config })
    harness.engine.start()

    harness.clock.advance(6 * 60_000)
    harness.engine.pump()

    expect(harness.engine.metrics().counters['deadline_gap_recovered']).toBe(1)

    harness.dispose()
  })

  /**
   * Review round 1, B1. The catch-up gave the recovery a second caller — the
   * running loop — and the store can refuse *that* write while the process keeps
   * serving. Adopting `recovery.state` before the commit made the refusal
   * invisible: the pending rows stayed overdue in the database, the in-memory
   * set was already re-armed, so no later pass had anything overdue to retry and
   * `/health` walked back from `degraded` to `live` on a gap that was never
   * recovered. That is memory claiming authority the store never granted
   * (spec §10.2, §11 상태 복구).
   */
  it('does not adopt a recovery the store refused, and retries it on the next pass', () => {
    const harness = createEngineHarness()
    harness.engine.start()
    const competitor = new Database(harness.temp.file)

    harness.clock.advance(31 * DAY_MS)
    const jumpedTo = harness.clock.nowUtcIso()
    lockOnDeadlineRecovery(harness.store, competitor)

    // The refused pass. `pump()` records the failure instead of throwing, which
    // is what the production timer does.
    const refused = harness.engine.pump()

    expect(refused).toBe(0)
    expect(harness.engine.health().lastFailure?.error ?? '').toMatch(/database is locked|BUSY/i)
    // The fixture has to have produced the fault it is about to assert on: the
    // gap is still in the store, exactly as the store last wrote it.
    const stranded = harness.store.listPendingDeadlines(jumpedTo)
    expect(stranded.length).toBeGreaterThan(0)
    expect(harness.engine.health().broadcastLifecycle).toBe('degraded')
    expect(harness.engine.health().degradedReasons).toContain('writer_failing')

    // The lock is gone (spec §9.1). The next ordinary pass has to see the same
    // gap again — before the fix it saw nothing overdue, because memory had
    // already dropped it.
    competitor.exec('ROLLBACK')
    const retried = harness.engine.pump()

    expect(retried).toBeGreaterThan(0)
    expect(harness.store.listPendingDeadlines(jumpedTo)).toHaveLength(0)
    // Counted once per attempt, so a second count is the evidence the pass
    // actually re-entered the recovery rather than skipping it.
    expect(harness.engine.metrics().counters['deadline_gap_recovered']).toBe(2)
    // And only now does the health surface say the gap is behind it.
    expect(harness.engine.health().broadcastLifecycle).toBe('live')
    expect(harness.engine.health().degradedReasons).toEqual([])

    competitor.close()
    harness.dispose()
  })

  /**
   * Review round 1, B2. `#recoverDeadlines()` delivered `plan.deliver` straight
   * to the reducer, going around the durable-ACK check the ordinary loop applies
   * to a due `paid_thanks_fallback` (R-T8-1 blocker 2). `effect_outbox.acked_at`
   * is written the instant the renderer confirms, while clearing the world's
   * obligation needs a commit — so a restart in between, followed by a gap large
   * enough for the recovery to own the timer, staged a second acknowledgement
   * for one payment (spec §9.2 "대체 감사 연출 한 번", §11 유료 무결성).
   */
  it('does not stage a substitute for a recovered fallback the renderer already acked', async () => {
    resetMessageIds()
    const harness = createEngineHarness()
    harness.engine.start()
    ingest(harness.engine, [
      superChatEnvelope({ messageId: 'msg_test_ack_gap', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()
    const original = harness.publisher.effects.find((effect) => effect.paid)
    expect(original?.payload).toMatchObject({ fallback: false })

    // The ACK is durable; the obligation is not cleared yet, and the process
    // dies before the commit that would clear it.
    harness.engine.onAckEffect(original?.effectId as string, at(1_100))
    expect(harness.store.getEffect(original?.effectId as string)?.ackedAt ?? null).not.toBeNull()

    const restarted = restartEngine(harness)
    // The gap: the host was away for 31 days, so `start()`'s §10.2 recovery — not
    // the ordinary loop — is what finds the substitute timer due.
    await restarted.clock.advance(31 * DAY_MS)
    restarted.engine.start()

    expect(fallbackStagings(restarted.publisher.effects)).toHaveLength(0)
    expect(restarted.engine.metrics().counters['paid_fallback_settled_by_ack']).toBe(1)
    // Closed for good: the obligation is out of the persisted state, so no later
    // pass and no further restart can revive it.
    expect(
      restarted.store.listPendingDeadlines().filter((row) => row.kind === 'paid_thanks_fallback'),
    ).toHaveLength(0)
    await restarted.clock.advance(60_000)
    restarted.engine.runPending()
    expect(fallbackStagings(restarted.publisher.effects)).toHaveLength(0)

    restarted.engine.stop()
    harness.dispose()
  })
})
