import { describe, expect, it } from 'vitest'

import { createEngineHarness, withEngineConfig } from './testing/harness.js'

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
})
