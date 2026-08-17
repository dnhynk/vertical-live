import { describe, expect, it } from 'vitest'

import { FRESHNESS_MINIMUMS } from './content/tuning.js'
import { initialWorldState } from './reducer.js'
import { runWorld } from './run.js'
import { MILLIS_PER_DAY, addMillis } from './time.js'
import {
  CRISIS_IDS,
  GROWTH_STAGES,
  NEED_IDS,
  TIME_SCALES,
  type WorldState,
  type WorldTransition,
} from './types.js'
import { computeFreshness, meetsFreshnessMinimums } from './variation.js'

/**
 * The acceptance criteria of TASK_SPECS §T7, driven through the pure reducer
 * with an injected clock and seed and **no viewer input at all** — which is the
 * case spec §2.1 says has to be a broadcast anyway.
 */

const START = '2026-08-17T21:00:00.000Z' // 06:00 JST, a chapter anchor
const SEEDS = ['seed_accept_1', 'seed_accept_2', 'seed_accept_3']

function zeroInputDay(seed: string): {
  readonly state: WorldState
  readonly transitions: readonly WorldTransition[]
} {
  const state = initialWorldState({ seed, startedAt: START })
  const run = runWorld({ to: addMillis(START, MILLIS_PER_DAY), state })
  expect(run.stoppedEarly).toBe(false)
  return { state: run.state, transitions: run.transitions }
}

describe('acceptance 1 — a virtual day with zero input (spec §2.1, §6.2)', () => {
  it.each(SEEDS)('completes a daily chapter with a start, a change and an end (%s)', (seed) => {
    const { transitions } = zeroInputDay(seed)
    const started = transitions.filter((it) => it.type === 'chapter_started')
    const turn = transitions.filter((it) => it.type === 'chapter_beat')
    const resolved = transitions.filter((it) => it.type === 'chapter_resolved')

    expect(started.length).toBeGreaterThanOrEqual(1)
    expect(turn).toHaveLength(1)
    expect(resolved).toHaveLength(1)
    // Start → change → end, in that order, inside the same day.
    expect(started[0]?.at).toBeDefined()
    expect(String(started[0]?.at) < String(turn[0]?.at)).toBe(true)
    expect(String(turn[0]?.at) < String(resolved[0]?.at)).toBe(true)

    // The change beat is where the room's decision point sits (spec §6.2, §6.4).
    expect(transitions.filter((it) => it.type === 'choice_opened')).toHaveLength(1)
    expect(transitions.filter((it) => it.type === 'choice_resolved')).toHaveLength(1)
  })

  it.each(SEEDS)('produces content on all four §6.2 time scales (%s)', (seed) => {
    const { transitions } = zeroInputDay(seed)
    const report = computeFreshness(transitions)
    for (const scale of TIME_SCALES) {
      expect(report.transitionsByScale[scale]).toBeGreaterThan(0)
    }
  })

  it.each(SEEDS)('meets the provisional freshness floors (%s)', (seed) => {
    const { transitions } = zeroInputDay(seed)
    const report = computeFreshness(transitions)

    // Provisional, per BOARD A-15: regression floors, not approved pass lines.
    expect(FRESHNESS_MINIMUMS.provisional).toBe(true)
    expect(report.uniqueTransitions).toBeGreaterThanOrEqual(
      FRESHNESS_MINIMUMS.uniqueTransitionsPerVirtualDay,
    )
    expect(report.repeatedNarrativeSceneRatio).toBeLessThanOrEqual(
      FRESHNESS_MINIMUMS.maxRepeatedNarrativeSceneRatio,
    )
    expect(meetsFreshnessMinimums(report)).toBe(true)
  })

  it.each(SEEDS)('never kills or permanently degrades the creature (%s)', (seed) => {
    const { state, transitions } = zeroInputDay(seed)
    const creature = state.world.creature

    expect(creature.growthStageIndex).toBeGreaterThanOrEqual(0)
    expect(GROWTH_STAGES[creature.growthStageIndex]).toBeDefined()
    for (const need of NEED_IDS) {
      expect(creature.needs[need]).toBeGreaterThanOrEqual(0)
      expect(creature.needs[need]).toBeLessThanOrEqual(1)
    }
    // Only the three recoverable states of spec §6.3 ever appear…
    for (const transition of transitions.filter((it) => it.type === 'crisis_entered')) {
      expect(CRISIS_IDS).toContain(transition.to)
    }
    // …and the day both entered and left a crisis with no viewer help at all.
    expect(transitions.filter((it) => it.type === 'crisis_entered').length).toBeGreaterThan(0)
    expect(transitions.filter((it) => it.type === 'crisis_recovered').length).toBeGreaterThan(0)
  })

  it('stages no paid effect when nobody paid (spec §2.6)', () => {
    const state = initialWorldState({ seed: 'seed_accept_paidless', startedAt: START })
    const run = runWorld({ to: addMillis(START, MILLIS_PER_DAY), state })
    expect(run.effects.some((effect) => effect.paid)).toBe(false)
    expect(run.state.audit.pendingThanks).toHaveLength(0)
  })
})

describe('acceptance 1b — growth completes on free participation alone (spec §2.3)', () => {
  it('reaches the last growth stage with no payment and no viewer input', () => {
    let state = initialWorldState({ seed: 'seed_accept_growth', startedAt: START })
    let at = START
    let previousStageIndex = state.world.creature.growthStageIndex
    let paidEffects = 0

    for (let day = 0; day < 8; day += 1) {
      at = addMillis(at, MILLIS_PER_DAY)
      const run = runWorld({ to: at, state })
      state = run.state
      paidEffects += run.effects.filter((effect) => effect.paid).length
      // Monotonic: a day can add a stage but can never take one away (§6.3).
      expect(state.world.creature.growthStageIndex).toBeGreaterThanOrEqual(previousStageIndex)
      previousStageIndex = state.world.creature.growthStageIndex
      if (previousStageIndex === GROWTH_STAGES.length - 1) break
    }

    expect(previousStageIndex).toBe(GROWTH_STAGES.length - 1)
    expect(paidEffects).toBe(0)
  })
})

describe('acceptance 2 — determinism (TASK_SPECS §T7)', () => {
  it('replays a full virtual day to the identical state and transitions', () => {
    const first = zeroInputDay('seed_accept_replay')
    const second = zeroInputDay('seed_accept_replay')
    expect(second.state).toEqual(first.state)
    expect(second.transitions).toEqual(first.transitions)
  })
})
