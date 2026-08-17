import { WorldSnapshotSchema } from '@vl/contract'
import { describe, expect, it } from 'vitest'

import { DEFAULT_WORLD_TUNING } from './content/tuning.js'
import { dominantNeed } from './creature.js'
import { projectWorldView } from './project.js'
import { initialWorldState, step, stepRngFor } from './reducer.js'
import { createRng } from './rng.js'
import { runWorld } from './run.js'
import { commandEvent, paidEvent, testEvent } from './test-support.js'
import { MILLIS_PER_HOUR, addMillis } from './time.js'
import type { StepInput, WorldState } from './types.js'

const START = '2026-08-17T21:00:00.000Z' // 2026-08-18 06:00 JST, a chapter anchor
const tuning = DEFAULT_WORLD_TUNING

function fresh(options: { gateOpen?: boolean; seed?: string } = {}): WorldState {
  return initialWorldState({
    seed: options.seed ?? 'seed_test_1',
    startedAt: START,
    identityGateOpen: options.gateOpen ?? false,
  })
}

function apply(state: WorldState, input: StepInput, now: string) {
  return step(state, input, now, stepRngFor(state, input))
}

describe('free care commands (spec §7.1, §6.3)', () => {
  it('relieves the matching need and stages a reaction', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const result = apply(state, { kind: 'event', event: commandEvent(at, 'FEED') }, at)

    expect(result.state.world.creature.needs.hungry).toBeLessThan(state.world.creature.needs.hungry)
    const reaction = result.effects.find((effect) => effect.kind === 'ACTION_REACTION')
    expect(reaction).toBeDefined()
    expect(reaction?.payload).toMatchObject({ commandName: 'FEED', contributionCount: 1 })
    expect(reaction?.cause).toEqual({ kind: 'event', eventKey: expect.any(String) })
    expect(result.state.world.lastAppliedAction).toMatchObject({
      commandName: 'FEED',
      contributionCount: 1,
    })
    expect(result.state.world.creature.bond.current).toBeGreaterThan(0)
    expect(result.state.world.creature.growth.current).toBeGreaterThan(0)
  })

  it('preserves the contribution count of an aggregated event (spec §6.4, §7.3)', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const result = apply(
      state,
      { kind: 'event', event: commandEvent(at, 'PLAY'), contributions: 25 },
      at,
    )
    const reaction = result.effects.find((effect) => effect.kind === 'ACTION_REACTION')
    expect(reaction?.payload).toMatchObject({ commandName: 'PLAY', contributionCount: 25 })
  })

  it('clamps an implausible contribution count instead of trusting it', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const result = apply(
      state,
      { kind: 'event', event: commandEvent(at, 'PET'), contributions: 10 ** 9 },
      at,
    )
    const reaction = result.effects.find((effect) => effect.kind === 'ACTION_REACTION')
    expect(reaction?.payload.contributionCount).toBe(10_000)
    expect(result.state.world.creature.needs.affection).toBeGreaterThanOrEqual(0)
  })

  it('lets free commands walk the creature out of a crisis (spec §6.3)', () => {
    const state = fresh()
    // Six hours of neglect is enough to push a need past the crisis threshold.
    const distressed = runWorld({ to: addMillis(START, 6 * MILLIS_PER_HOUR), state })
    expect(distressed.state.world.creature.crisis).not.toBe(null)

    let current = distressed.state
    let at = distressed.state.world.worldTimeUtc
    for (let index = 0; index < 12; index += 1) {
      at = addMillis(at, 1_000)
      const need = dominantNeed(current.world.creature.needs)
      const command = need === 'hungry' ? 'FEED' : need === 'play' ? 'PLAY' : 'PET'
      current = apply(current, { kind: 'event', event: commandEvent(at, command) }, at).state
    }
    expect(current.world.creature.crisis).toBe(null)
  })
})

describe('branch votes (spec §6.4, BOARD A-1, A-9)', () => {
  it('refuses a vote while the identity gate is closed and changes nothing', () => {
    const state = fresh({ gateOpen: false })
    const at = addMillis(START, 60_000)
    const result = apply(state, { kind: 'event', event: commandEvent(at, 'VOTE_A') }, at)

    expect(result.rejections).toEqual([
      { reason: 'vote_disabled', eventKey: expect.any(String), at },
    ])
    expect(result.state.world).toBe(state.world)
    expect(result.effects).toHaveLength(0)
  })

  it('refuses a vote when no window is open even with the gate open', () => {
    const state = fresh({ gateOpen: true })
    const at = addMillis(START, 60_000)
    const result = apply(state, { kind: 'event', event: commandEvent(at, 'VOTE_B') }, at)
    expect(result.rejections[0]?.reason).toBe('vote_window_closed')
    expect(result.state.world).toBe(state.world)
  })

  it('opens a vote window with A/B/C commands when the gate is open', () => {
    // The turn beat opens the window 35% into the 24h chapter; 8h30m is inside it.
    const run = runWorld({
      to: addMillis(START, 8.5 * MILLIS_PER_HOUR),
      state: fresh({ gateOpen: true }),
    })
    const choice = run.state.world.choice
    expect(choice?.mode).toBe('vote')
    expect(choice?.options.map((option) => option.commandName)).toEqual([
      'VOTE_A',
      'VOTE_B',
      'VOTE_C',
    ])

    const at = addMillis(run.state.world.worldTimeUtc, 1_000)
    const voted = apply(run.state, { kind: 'event', event: commandEvent(at, 'VOTE_C') }, at)
    expect(voted.rejections).toHaveLength(0)
    expect(voted.state.world.choice?.voteTally).toEqual({ VOTE_C: 1 })
  })

  it('opens a director window with no vote commands when the gate is closed', () => {
    const run = runWorld({ to: addMillis(START, 8.5 * MILLIS_PER_HOUR), state: fresh() })
    const choice = run.state.world.choice
    expect(choice?.mode).toBe('director')
    expect(choice?.options.map((option) => option.commandName)).toEqual([null, null, null])
    expect(choice?.options.every((option) => option.eventCombinationId.startsWith('combo_'))).toBe(
      true,
    )
  })

  it('counts free commands non-competitively while a director window is open', () => {
    const run = runWorld({ to: addMillis(START, 8.5 * MILLIS_PER_HOUR), state: fresh() })
    const at = addMillis(run.state.world.worldTimeUtc, 1_000)
    const contributed = apply(
      run.state,
      { kind: 'event', event: commandEvent(at, 'FEED'), contributions: 4 },
      at,
    )
    expect(contributed.state.world.choice?.contributionTally).toEqual({ FEED: 4 })
    expect(contributed.state.world.choice?.voteTally).toEqual({})
  })

  it('resolves the chapter branch on both paths', () => {
    for (const gateOpen of [false, true]) {
      const run = runWorld({
        to: addMillis(START, 11 * MILLIS_PER_HOUR),
        state: fresh({ gateOpen }),
      })
      expect(run.state.world.choice).toBe(null)
      expect(run.state.world.chapter.branchChoiceId).not.toBe(null)
      const resolved = run.transitions.filter((it) => it.type === 'choice_resolved')
      expect(resolved).toHaveLength(1)
      expect(resolved[0]?.from).toBe(gateOpen ? 'vote' : 'director')
    }
  })
})

describe('inputs the world refuses', () => {
  it('rejects an event that carries no command', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const result = apply(state, { kind: 'event', event: testEvent(at, { kind: 'SYSTEM' }) }, at)
    expect(result.rejections[0]?.reason).toBe('not_a_world_input')
    expect(result.state.world).toBe(state.world)
  })

  it('rejects a second acknowledgement of the same paid event', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const event = paidEvent(at, 'SUPER_CHAT')
    const once = apply(state, { kind: 'event', event }, at)
    const twice = apply(once.state, { kind: 'event', event }, at)
    expect(twice.rejections[0]?.reason).toBe('duplicate_paid_event')
    expect(twice.effects).toHaveLength(0)
  })
})

describe('determinism (TASK_SPECS §T7 acceptance 2)', () => {
  const events = [
    { at: addMillis(START, 5 * 60_000), event: commandEvent(addMillis(START, 5 * 60_000), 'FEED') },
    { at: addMillis(START, 9 * 60_000), event: commandEvent(addMillis(START, 9 * 60_000), 'PLAY') },
    {
      at: addMillis(START, 40 * 60_000),
      event: commandEvent(addMillis(START, 40 * 60_000), 'PET'),
    },
  ]

  it('produces the same state and transitions for the same seed and inputs', () => {
    const to = addMillis(START, 6 * MILLIS_PER_HOUR)
    const first = runWorld({ to, state: fresh({ seed: 'seed_test_determinism' }), events })
    const second = runWorld({ to, state: fresh({ seed: 'seed_test_determinism' }), events })
    expect(second.state).toEqual(first.state)
    expect(second.transitions).toEqual(first.transitions)
    expect(second.effects).toEqual(first.effects)
  })

  it('produces a different world for a different seed', () => {
    const to = addMillis(START, 6 * MILLIS_PER_HOUR)
    const first = runWorld({ to, state: fresh({ seed: 'seed_test_a' }), events })
    const second = runWorld({ to, state: fresh({ seed: 'seed_test_b' }), events })
    expect(second.transitions).not.toEqual(first.transitions)
  })

  it('does not depend on the identity of the injected generator', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const input: StepInput = { kind: 'event', event: commandEvent(at, 'FEED') }
    const a = step(state, input, at, createRng('same'))
    const b = step(state, input, at, createRng('same'))
    expect(b.state).toEqual(a.state)
    expect(b.effects).toEqual(a.effects)
  })
})

describe('read model projection (spec §5.2)', () => {
  it('fills the four fixed display slots and validates against the contract', () => {
    const run = runWorld({ to: addMillis(START, 3 * MILLIS_PER_HOUR), state: fresh() })
    const view = projectWorldView(run.state)

    const snapshot = {
      schemaVersion: 1 as const,
      stateRevision: 12,
      processedIngestSeq: 34,
      inputMode: 'direct' as const,
      interactionEnabled: true,
      broadcastLifecycle: 'live' as const,
      ...view,
    }
    const parsed = WorldSnapshotSchema.safeParse(snapshot)
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)

    expect(view.display.currentNeedOrMission.textKey).toMatch(/^(need|mission|crisis)\./)
    expect(view.display.growthOrChapterProgress.textKey).toMatch(/^chapter\./)
    expect(view.nextTransitionAt >= view.worldTimeUtc).toBe(true)
  })

  it('previews the next choice time while the gate is closed (spec §6.4)', () => {
    const run = runWorld({ to: addMillis(START, 2 * MILLIS_PER_HOUR), state: fresh() })
    const view = projectWorldView(run.state)
    expect(view.mission.choices).toEqual([])
    expect(view.display.nextChoiceAt).not.toBe(null)
  })

  it('carries no author, name or free text anywhere in the view', () => {
    const run = runWorld({ to: addMillis(START, MILLIS_PER_HOUR), state: fresh() })
    const serialized = JSON.stringify(projectWorldView(run.state))
    for (const forbidden of ['author', 'displayName', 'channelId', 'message', 'text"']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })
})

describe('tuning override', () => {
  it('accepts a caller-provided tuning so T8 can feed config (BOARD A-15)', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const generous = {
      ...tuning,
      needs: { ...tuning.needs, relief: { FEED: 1, PLAY: 1, PET: 1 } },
    }
    const input: StepInput = { kind: 'event', event: commandEvent(at, 'FEED') }
    const result = step(state, input, at, stepRngFor(state, input), { tuning: generous })
    expect(result.state.world.creature.needs.hungry).toBe(0)
  })
})
