import { afterEach, describe, expect, it } from 'vitest'

import { RetentionScheduler } from './scheduler.js'
import { RetentionSweeper, type RetentionSweepResult } from './retention.js'
import {
  DAY_MS,
  createRetentionHarness,
  seedInbox,
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

describe('RetentionScheduler', () => {
  it('sweeps immediately and then on the configured interval', async () => {
    const active = open()
    const results: RetentionSweepResult[] = []
    scheduler = new RetentionScheduler({
      sweeper: sweeperFor(active),
      clock: active.clock,
      intervalMs: 60 * 60 * 1000,
      onResult: (result) => results.push(result),
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
      onError: (error) => errors.push(error),
    })
    scheduler.start()

    expect(errors).toHaveLength(1)
    // A retention job that stopped after one bad run is exactly the silent
    // failure this task exists to prevent.
    await active.clock.advance(2000)
    expect(calls).toBe(3)
    expect(errors).toHaveLength(1)
  })

  it('defaults the interval to the config and rejects a bad one', () => {
    const active = open()
    scheduler = new RetentionScheduler({ sweeper: sweeperFor(active), clock: active.clock })
    expect(scheduler.intervalMs).toBe(active.config.sweep.intervalMs)
    expect(
      () =>
        new RetentionScheduler({
          sweeper: sweeperFor(active),
          clock: active.clock,
          intervalMs: 0,
        }),
    ).toThrow(/positive integer/)
  })
})
