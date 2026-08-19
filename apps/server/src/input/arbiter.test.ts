import type { CommandName, CommandRef } from '@vl/contract'
import { describe, expect, it } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import {
  InputArbiter,
  InputArbiterConfigError,
  type CommandWindowTally,
  type InputWindowConfig,
} from './arbiter.js'

const CONFIG: InputWindowConfig = {
  windowMs: 5000,
  enterAggregateAtCommands: 10,
  exitAggregateAtCommands: 3,
  maxDirectPerWindow: 6,
}

const command = (name: CommandName = 'FEED'): CommandRef => ({ name, argument: null })

function makeArbiter(config: Partial<InputWindowConfig> = {}) {
  const clock = new FakeClock()
  const arbiter = new InputArbiter({ clock, config: { ...CONFIG, ...config } })
  return { clock, arbiter }
}

/** Advances the fake clock without letting a timer fire; the arbiter has none. */
async function advance(clock: FakeClock, ms: number): Promise<void> {
  await clock.advance(ms)
}

function sumTallies(
  counts: Readonly<Record<CommandName, CommandWindowTally>> | undefined,
  field: keyof CommandWindowTally,
): number {
  return Object.values(counts ?? {}).reduce((total, tally) => total + tally[field], 0)
}

describe('config validation', () => {
  it('rejects a non-positive window', () => {
    expect(() => makeArbiter({ windowMs: 0 })).toThrow(InputArbiterConfigError)
  })

  it('rejects thresholds that cannot produce hysteresis', () => {
    expect(() => makeArbiter({ exitAggregateAtCommands: 20 })).toThrow(InputArbiterConfigError)
  })

  it('rejects a negative flood-control cap', () => {
    expect(() => makeArbiter({ maxDirectPerWindow: -1 })).toThrow(InputArbiterConfigError)
  })
})

describe('direct mode', () => {
  it('starts in direct mode (BOARD A-3)', () => {
    const { arbiter } = makeArbiter()
    expect(arbiter.mode).toBe('direct')
  })

  it('resumes in the recovered mode when one is supplied', () => {
    const arbiter = new InputArbiter({
      clock: new FakeClock(),
      config: CONFIG,
      initialMode: 'aggregate',
    })
    expect(arbiter.mode).toBe('aggregate')
    expect(arbiter.admit(command()).disposition).toBe('aggregated')
  })

  it('applies commands in order up to the flood-control cap', () => {
    const { arbiter } = makeArbiter()
    const dispositions = Array.from({ length: 9 }, () => arbiter.admit(command()).disposition)
    expect(dispositions).toEqual([
      'direct',
      'direct',
      'direct',
      'direct',
      'direct',
      'direct',
      'aggregated',
      'aggregated',
      'aggregated',
    ])
  })

  it('preserves every contribution when the cap is exceeded', async () => {
    const { clock, arbiter } = makeArbiter()
    for (let index = 0; index < 9; index += 1) {
      arbiter.admit(command())
    }
    await advance(clock, CONFIG.windowMs)
    const [window] = arbiter.drainClosedWindows()
    expect(window).toMatchObject({
      acceptedCount: 9,
      directAppliedCount: 6,
      aggregatedCount: 3,
      counts: {
        FEED: { directApplied: 6, aggregatedOnly: 3 },
        PLAY: { directApplied: 0, aggregatedOnly: 0 },
      },
    })
  })

  /**
   * R-T6-1 blocker 2: with one scalar pair for the whole window, a caller that
   * applied the direct commands as they arrived could not tell which
   * contributions were still outstanding — applying `counts` replayed FEED,
   * skipping it lost PLAY.
   */
  it('splits a mixed window per command into applied and outstanding', async () => {
    const { clock, arbiter } = makeArbiter({ maxDirectPerWindow: 1 })
    expect(arbiter.admit(command('FEED')).disposition).toBe('direct')
    expect(arbiter.admit(command('PLAY')).disposition).toBe('aggregated')
    await advance(clock, CONFIG.windowMs)

    const [window] = arbiter.drainClosedWindows()
    expect(window?.counts).toEqual({
      FEED: { directApplied: 1, aggregatedOnly: 0 },
      PLAY: { directApplied: 0, aggregatedOnly: 1 },
      PET: { directApplied: 0, aggregatedOnly: 0 },
      VOTE_A: { directApplied: 0, aggregatedOnly: 0 },
      VOTE_B: { directApplied: 0, aggregatedOnly: 0 },
      VOTE_C: { directApplied: 0, aggregatedOnly: 0 },
    })
    // Applying only `aggregatedOnly` neither replays FEED nor loses PLAY, and
    // the two halves still add up to every accepted command.
    expect(window?.acceptedCount).toBe(2)
    expect(sumTallies(window?.counts, 'directApplied')).toBe(window?.directAppliedCount)
    expect(sumTallies(window?.counts, 'aggregatedOnly')).toBe(window?.aggregatedCount)
  })
})

describe('mode switching is deterministic under an injected clock', () => {
  it('enters aggregate for the window after a burst', async () => {
    const { clock, arbiter } = makeArbiter()
    for (let index = 0; index < CONFIG.enterAggregateAtCommands; index += 1) {
      arbiter.admit(command())
    }
    expect(arbiter.mode).toBe('direct')

    await advance(clock, CONFIG.windowMs)
    expect(arbiter.mode).toBe('aggregate')
    expect(arbiter.admit(command()).disposition).toBe('aggregated')
  })

  it('stays in aggregate while traffic stays above the exit threshold', async () => {
    const { clock, arbiter } = makeArbiter()
    for (let index = 0; index < CONFIG.enterAggregateAtCommands; index += 1) {
      arbiter.admit(command())
    }
    await advance(clock, CONFIG.windowMs)
    expect(arbiter.mode).toBe('aggregate')

    for (let index = 0; index < CONFIG.exitAggregateAtCommands + 1; index += 1) {
      arbiter.admit(command())
    }
    await advance(clock, CONFIG.windowMs)
    expect(arbiter.mode).toBe('aggregate')
  })

  it('returns to direct after a quiet window', async () => {
    const { clock, arbiter } = makeArbiter()
    for (let index = 0; index < CONFIG.enterAggregateAtCommands; index += 1) {
      arbiter.admit(command())
    }
    await advance(clock, CONFIG.windowMs)
    arbiter.admit(command())
    await advance(clock, CONFIG.windowMs)
    expect(arbiter.mode).toBe('direct')
  })

  it('returns to direct after a fully idle stretch', async () => {
    const { clock, arbiter } = makeArbiter()
    for (let index = 0; index < CONFIG.enterAggregateAtCommands; index += 1) {
      arbiter.admit(command())
    }
    await advance(clock, CONFIG.windowMs)
    expect(arbiter.mode).toBe('aggregate')
    expect(arbiter.drainClosedWindows()).toHaveLength(1)

    await advance(clock, CONFIG.windowMs * 20)
    expect(arbiter.mode).toBe('direct')
    // Idle windows carry no contribution, so they produce no result to apply.
    expect(arbiter.drainClosedWindows()).toHaveLength(0)
  })

  it('does not switch part way through a window', async () => {
    const { clock, arbiter } = makeArbiter()
    for (let index = 0; index < CONFIG.enterAggregateAtCommands * 2; index += 1) {
      arbiter.admit(command())
      await advance(clock, 1)
    }
    expect(arbiter.mode).toBe('direct')
  })

  it('produces identical results for identical timings', async () => {
    const run = async () => {
      const { clock, arbiter } = makeArbiter()
      const dispositions: string[] = []
      for (let index = 0; index < 25; index += 1) {
        dispositions.push(arbiter.admit(command(index % 2 === 0 ? 'FEED' : 'PLAY')).disposition)
        await advance(clock, 400)
      }
      return { dispositions, windows: arbiter.drainClosedWindows() }
    }
    expect(await run()).toEqual(await run())
  })
})

describe('closed windows', () => {
  it('reports absolute UTC boundaries derived from the injected clock', async () => {
    const { clock, arbiter } = makeArbiter()
    arbiter.admit(command())
    await advance(clock, CONFIG.windowMs)
    const [window] = arbiter.drainClosedWindows()
    expect(window?.startedAtUtc).toBe('2026-01-01T00:00:00.000Z')
    expect(window?.endedAtUtc).toBe('2026-01-01T00:00:05.000Z')
  })

  it('drains once', async () => {
    const { clock, arbiter } = makeArbiter()
    arbiter.admit(command())
    await advance(clock, CONFIG.windowMs)
    expect(arbiter.drainClosedWindows()).toHaveLength(1)
    expect(arbiter.drainClosedWindows()).toHaveLength(0)
  })

  it('keeps a per-command tally across a mixed window', async () => {
    const { clock, arbiter } = makeArbiter()
    arbiter.admit(command('FEED'))
    arbiter.admit(command('PLAY'))
    arbiter.admit(command('PLAY'))
    arbiter.admit(command('PET'))
    await advance(clock, CONFIG.windowMs)
    const [window] = arbiter.drainClosedWindows()
    expect(window?.counts).toEqual({
      FEED: { directApplied: 1, aggregatedOnly: 0 },
      PLAY: { directApplied: 2, aggregatedOnly: 0 },
      PET: { directApplied: 1, aggregatedOnly: 0 },
      VOTE_A: { directApplied: 0, aggregatedOnly: 0 },
      VOTE_B: { directApplied: 0, aggregatedOnly: 0 },
      VOTE_C: { directApplied: 0, aggregatedOnly: 0 },
    })
    expect(window?.acceptedCount).toBe(4)
  })
})

describe('snapshot view (spec §6.4)', () => {
  it('exposes the open window in the contract shape', () => {
    const { arbiter } = makeArbiter()
    arbiter.admit(command('FEED'))
    arbiter.admit(command('FEED'))
    arbiter.admit(command('PET'))
    expect(arbiter.currentWindow()).toEqual({
      mode: 'direct',
      endsAt: '2026-01-01T00:00:05.000Z',
      tallies: [
        { commandName: 'FEED', count: 2 },
        { commandName: 'PET', count: 1 },
      ],
    })
  })

  it('reports the remaining time from the monotonic clock', async () => {
    const { clock, arbiter } = makeArbiter()
    await advance(clock, 1500)
    expect(arbiter.remainingMs()).toBe(3500)
  })
})

/**
 * Per-consented-viewer rules (BOARD D-9, A-9). Everything below needs an
 * `actor`; the anonymous path above must behave exactly as it did before, which
 * is what the rest of this file already pins down.
 */
describe('consented viewers', () => {
  const ACTOR_ONE = {
    kind: 'consented',
    displayName: 'synthetic-viewer-1',
    channelRef: 'ref_00000000000000000000000000000001',
  } as const
  const ACTOR_TWO = {
    kind: 'consented',
    displayName: 'synthetic-viewer-2',
    channelRef: 'ref_00000000000000000000000000000002',
  } as const

  function withPerUser(cooldownMs = 5000) {
    const clock = new FakeClock()
    const arbiter = new InputArbiter({ clock, config: CONFIG, perUser: { cooldownMs } })
    return { clock, arbiter }
  }

  it('suppresses a second command inside the cooldown and lets the next one through', async () => {
    const { clock, arbiter } = withPerUser(5000)

    expect(arbiter.admit(command('FEED'), ACTOR_ONE).disposition).toBe('direct')

    await advance(clock, 1000)
    const blocked = arbiter.admit(command('PET'), ACTOR_ONE)
    expect(blocked.disposition).toBe('suppressed')
    expect(blocked.reason).toBe('cooldown')

    await advance(clock, 4100)
    expect(arbiter.admit(command('PET'), ACTOR_ONE).disposition).toBe('direct')
  })

  it('does not let one viewer cooldown touch anybody else', async () => {
    const { clock, arbiter } = withPerUser(5000)
    arbiter.admit(command('FEED'), ACTOR_ONE)
    await advance(clock, 1000)

    expect(arbiter.admit(command('FEED'), ACTOR_TWO).disposition).toBe('direct')
    // And an anonymous viewer is never subject to it: `actor` is null, so no
    // per-user claim is made at all (spec §6.4, BOARD A-1).
    expect(arbiter.admit(command('FEED')).disposition).toBe('direct')
    expect(arbiter.admit(command('FEED')).disposition).toBe('direct')
  })

  it('leaves a suppressed command out of the tally entirely', async () => {
    // A cooldown that folded the command into the aggregate would not be a
    // cooldown: the contribution would still count.
    const { clock, arbiter } = withPerUser(5000)
    arbiter.admit(command('FEED'), ACTOR_ONE)
    await advance(clock, 100)
    arbiter.admit(command('FEED'), ACTOR_ONE)

    await advance(clock, 5000)
    const [closed] = arbiter.drainClosedWindows()
    expect(closed?.acceptedCount).toBe(1)
    expect(sumTallies(closed?.counts, 'directApplied')).toBe(1)
    expect(sumTallies(closed?.counts, 'aggregatedOnly')).toBe(0)
  })

  it('counts one vote per viewer per choice window', async () => {
    const { clock, arbiter } = withPerUser(0)
    const scope = 'gathering:2026-01-01T00:00:00.000Z'

    expect(arbiter.admit(command('VOTE_A'), ACTOR_ONE, scope).disposition).toBe('direct')
    const second = arbiter.admit(command('VOTE_B'), ACTOR_ONE, scope)
    expect(second.disposition).toBe('suppressed')
    expect(second.reason).toBe('already_voted')
    // Another viewer votes freely in the same window.
    expect(arbiter.admit(command('VOTE_B'), ACTOR_TWO, scope).disposition).toBe('direct')

    // A care command is not a vote, so it is not blocked by having voted.
    expect(arbiter.admit(command('FEED'), ACTOR_ONE, scope).disposition).toBe('direct')

    // The next choice window is a different decision.
    await advance(clock, 6000)
    const next = 'festival_prep:2026-01-01T00:10:00.000Z'
    expect(arbiter.admit(command('VOTE_C'), ACTOR_ONE, next).disposition).toBe('direct')
  })

  it('forgets a vote when its window is dropped', () => {
    const { arbiter } = withPerUser(0)
    const scope = 'gathering:2026-01-01T00:00:00.000Z'
    arbiter.admit(command('VOTE_A'), ACTOR_ONE, scope)
    expect(arbiter.admit(command('VOTE_A'), ACTOR_ONE, scope).disposition).toBe('suppressed')

    arbiter.forgetVoteScope(scope)
    expect(arbiter.admit(command('VOTE_A'), ACTOR_ONE, scope).disposition).toBe('direct')
  })

  it('keeps a voter out of the prune until their scope is retired', async () => {
    // Review round 1 (M4): a viewer with a remembered vote is exempt from
    // `#pruneViewers`, so their `channelRef` stays in memory across window
    // closes — for the whole broadcast if nothing ever retires the scope. The
    // engine retires it when the choice window changes; this is what that does.
    const { clock, arbiter } = withPerUser(5000)
    const scope = 'gathering:2026-01-01T00:00:00.000Z'
    arbiter.admit(command('VOTE_A'), ACTOR_ONE, scope)

    // Two windows later, with the cooldown long expired, the vote is still known.
    await advance(clock, 11_000)
    arbiter.drainClosedWindows()
    expect(arbiter.admit(command('VOTE_A'), ACTOR_ONE, scope).disposition).toBe('suppressed')

    arbiter.forgetVoteScope(scope)
    await advance(clock, 11_000)
    arbiter.drainClosedWindows()
    expect(arbiter.admit(command('VOTE_B'), ACTOR_ONE, scope).disposition).toBe('direct')
  })

  it('purges a viewer whose identity was deleted', async () => {
    // `LEAVE`, a deletion request or the 30-day sweep: the consent row is gone,
    // so the arbiter must not keep the reference it was keyed by (review round
    // 1, M4). Observable as the cooldown disappearing with it.
    const { clock, arbiter } = withPerUser(5000)
    arbiter.admit(command('FEED'), ACTOR_ONE)
    await advance(clock, 100)
    expect(arbiter.admit(command('FEED'), ACTOR_ONE).disposition).toBe('suppressed')

    arbiter.forgetViewer(ACTOR_ONE.channelRef)
    expect(arbiter.admit(command('FEED'), ACTOR_ONE).disposition).toBe('direct')
    // And it is only that viewer: nobody else's state is touched.
    arbiter.admit(command('FEED'), ACTOR_TWO)
    await advance(clock, 100)
    expect(arbiter.admit(command('FEED'), ACTOR_TWO).disposition).toBe('suppressed')
  })

  it('applies no per-user rule at all when none is configured', async () => {
    // The closed configuration and any caller that does not pass `perUser`.
    const { clock, arbiter } = makeArbiter()
    expect(arbiter.admit(command('FEED'), ACTOR_ONE).disposition).toBe('direct')
    await advance(clock, 1)
    expect(arbiter.admit(command('FEED'), ACTOR_ONE).disposition).toBe('direct')
  })

  it('rejects a negative cooldown', () => {
    const clock = new FakeClock()
    expect(() => new InputArbiter({ clock, config: CONFIG, perUser: { cooldownMs: -1 } })).toThrow(
      InputArbiterConfigError,
    )
  })
})
