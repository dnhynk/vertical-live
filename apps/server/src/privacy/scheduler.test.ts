import { afterEach, describe, expect, it } from 'vitest'

import { RetentionScheduler } from './scheduler.js'
import { RetentionSweeper, type RetentionSweepResult } from './retention.js'
import {
  DAY_MS,
  createRetentionHarness,
  seedInbox,
  seedState,
  type RetentionHarness,
} from './testing/harness.js'

/**
 * The periodic driver of the sweep. Time comes from the injected `Clock`, so a
 * 30-day rule is exercised by advancing a virtual clock (spec §10.2, TASK_SPECS
 * §T13 acceptance 1).
 */

const T0 = '2026-01-01T00:00:00.000Z'

let harness: RetentionHarness | undefined
let scheduler: RetentionScheduler | undefined

afterEach(() => {
  scheduler?.stop()
  scheduler = undefined
  harness?.dispose()
  harness = undefined
})

function open(): RetentionHarness {
  harness = createRetentionHarness()
  return harness
}

function sweeperFor(active: RetentionHarness): RetentionSweeper {
  return new RetentionSweeper({ store: active.store, clock: active.clock, config: active.config })
}

/** Both sinks are required, so tests that do not care still have to pass them. */
function noop(): void {
  // intentionally empty
}

describe('RetentionScheduler', () => {
  it('sweeps immediately and then on the configured interval', async () => {
    const active = open()
    const results: RetentionSweepResult[] = []
    scheduler = new RetentionScheduler({
      sweeper: sweeperFor(active),
      clock: active.clock,
      intervalMs: 60 * 60 * 1000,
      onResult: (result) => results.push(result),
      onError: noop,
    })

    scheduler.start()
    // Immediately, because deletions that came due during downtime must not wait
    // out a full interval after a restart.
    expect(scheduler.runCount).toBe(1)
    expect(results).toHaveLength(1)
    expect(scheduler.running).toBe(true)

    await active.clock.advance(3 * 60 * 60 * 1000)
    expect(scheduler.runCount).toBe(4)

    scheduler.stop()
    expect(scheduler.running).toBe(false)
    await active.clock.advance(3 * 60 * 60 * 1000)
    expect(scheduler.runCount).toBe(4)
  })

  it('deletes expired rows on the tick that crosses the 30-day line', async () => {
    const active = open()
    seedInbox(active.store, 2, T0)
    scheduler = new RetentionScheduler({
      sweeper: sweeperFor(active),
      clock: active.clock,
      intervalMs: DAY_MS,
      onResult: noop,
      onError: noop,
    })

    scheduler.start()
    await active.clock.advance(29 * DAY_MS)
    expect(active.store.countRows('ingest_inbox')).toBe(2)

    await active.clock.advance(2 * DAY_MS)
    expect(active.store.countRows('ingest_inbox')).toBe(0)
    const ledger = active.store.listRetentionLedger({ fieldKey: 'ingest_inbox.envelope' })
    expect(ledger.filter((row) => row.outcome === 'deleted')).toHaveLength(1)
  })

  it('keeps sweeping after a failed run', async () => {
    const active = open()
    const errors: unknown[] = []
    let calls = 0
    const failing = {
      config: active.config,
      run: (): RetentionSweepResult => {
        calls += 1
        if (calls === 1) throw new Error('injected sweep failure')
        return sweeperFor(active).run()
      },
    } as unknown as RetentionSweeper

    scheduler = new RetentionScheduler({
      sweeper: failing,
      clock: active.clock,
      intervalMs: 1000,
      onResult: noop,
      onError: (error) => errors.push(error),
    })
    scheduler.start()

    expect(errors).toHaveLength(1)
    // Also kept in state, so a caller whose sink itself throws still sees it.
    expect(scheduler.failures).toHaveLength(1)
    expect(scheduler.unhealthy).toBe(true)
    // A retention job that stopped after one bad run is exactly the silent
    // failure this task exists to prevent.
    await active.clock.advance(2000)
    expect(calls).toBe(3)
    expect(errors).toHaveLength(1)
  })

  it('defaults the interval to the config and rejects a bad one', () => {
    const active = open()
    scheduler = new RetentionScheduler({
      sweeper: sweeperFor(active),
      clock: active.clock,
      onResult: noop,
      onError: noop,
    })
    expect(scheduler.intervalMs).toBe(active.config.sweep.intervalMs)
    expect(
      () =>
        new RetentionScheduler({
          sweeper: sweeperFor(active),
          clock: active.clock,
          intervalMs: 0,
          onResult: noop,
          onError: noop,
        }),
    ).toThrow(/positive integer/)
  })

  it('refuses to be constructed without a result or error sink', () => {
    // Review round 1, B2: with optional sinks a missed T12 wire turned a failed
    // §12.4 deletion into silence. Both are required, and a plain-JS caller that
    // omits one is refused at construction rather than at the first failure.
    const active = open()
    const base = { sweeper: sweeperFor(active), clock: active.clock, intervalMs: 1000 }
    expect(() => new RetentionScheduler({ ...base, onError: noop } as never)).toThrow(
      /onResult is required/,
    )
    expect(() => new RetentionScheduler({ ...base, onResult: noop } as never)).toThrow(
      /onError is required/,
    )
    expect(
      () => new RetentionScheduler({ ...base, onResult: noop, onError: 'nope' } as never),
    ).toThrow(TypeError)
  })

  it('keeps the schedule when the error sink itself throws', async () => {
    // Review round 2, M1: `onError` ran before the timer assignment and outside a
    // `finally`, so a broken alert path ended the schedule — a failed sweep was
    // observable but no later §12.4 deletion would ever run.
    const active = open()
    let calls = 0
    const failing = {
      config: active.config,
      run: (): RetentionSweepResult => {
        calls += 1
        if (calls === 1) throw new Error('injected sweep failure')
        return sweeperFor(active).run()
      },
    } as unknown as RetentionSweeper

    scheduler = new RetentionScheduler({
      sweeper: failing,
      clock: active.clock,
      intervalMs: 1000,
      onResult: noop,
      onError: () => {
        throw new Error('alert sink unavailable')
      },
    })
    scheduler.start()

    expect(calls).toBe(1)
    expect(scheduler.running).toBe(true)
    // The sweep failure and the sink failure are both recorded.
    expect(scheduler.failures.map((failure) => failure.stage)).toEqual(['sweep', 'onError'])
    expect(scheduler.unhealthy).toBe(true)

    await active.clock.advance(2000)
    expect(calls).toBe(3)
  })

  it('keeps the schedule when the result sink throws', async () => {
    const active = open()
    scheduler = new RetentionScheduler({
      sweeper: sweeperFor(active),
      clock: active.clock,
      intervalMs: 1000,
      onResult: () => {
        throw new Error('alert sink unavailable')
      },
      onError: noop,
    })
    scheduler.start()

    expect(scheduler.runCount).toBe(1)
    expect(scheduler.failures.map((failure) => failure.stage)).toEqual(['onResult'])
    await active.clock.advance(2000)
    expect(scheduler.runCount).toBe(3)
  })

  it('reports an unmet obligation through the result sink and its own state', async () => {
    const active = open()
    // A world snapshot untouched for longer than its re-verification period leaves
    // the sweep non-clean; that must reach the sink, not just the log.
    seedState(active.store, { at: T0, revision: 1, processedSeq: 0 })
    await active.clock.advance(31 * DAY_MS)

    const results: RetentionSweepResult[] = []
    scheduler = new RetentionScheduler({
      sweeper: sweeperFor(active),
      clock: active.clock,
      intervalMs: DAY_MS,
      onResult: (result) => results.push(result),
      onError: noop,
    })
    scheduler.start()

    expect(results[0]?.clean).toBe(false)
    expect(results[0]?.reverificationDue).toEqual(['world_snapshot.snapshot'])
    expect(scheduler.lastResult?.clean).toBe(false)
    expect(scheduler.unhealthy).toBe(true)
    expect(scheduler.failures).toEqual([])
  })
})
