import { describe, expect, it } from 'vitest'

import { DEFAULT_WORLD_TUNING } from './content/tuning.js'
import { IDLE_VARIANTS, REACTION_VARIANTS, matchesCondition } from './content/variants.js'
import type { ContentContext, Variant } from './content/variants.js'
import { initialWorldState, step, stepRngFor } from './reducer.js'
import { createRng } from './rng.js'
import { runWorld } from './run.js'
import { commandEvent } from './test-support.js'
import { MILLIS_PER_HOUR, addMillis } from './time.js'
import type { VariationState, WorldTransition } from './types.js'
import {
  computeFreshness,
  countUniqueTransitions,
  rememberVariant,
  repeatedSceneRatio,
  sceneKeyFor,
  selectVariant,
  transitionSignature,
} from './variation.js'

const tuning = DEFAULT_WORLD_TUNING
const START = '2026-08-17T21:00:00.000Z'

const context: ContentContext = {
  phase: 'morning',
  weather: 'clear',
  environment: 'garden',
  chapter: 'gathering',
  beat: 'setup',
  crisis: null,
  emotion: 'joyful',
  dominantNeed: 'hungry',
  growthStage: 'hatchling',
  visitor: null,
}

const empty: VariationState = { recentVariantIds: [], recentSceneKeys: [] }

function transition(overrides: Partial<WorldTransition> = {}): WorldTransition {
  return {
    type: 'idle_beat',
    at: START,
    variantId: 'idle_slow_breath',
    from: null,
    to: 'idle_slow_breath',
    cause: 'deadline',
    sceneKey: 'idle_slow_breath@garden/clear/morning',
    ...overrides,
  }
}

describe('variant conditions (spec §12.5)', () => {
  it('matches only variants whose condition the world satisfies', () => {
    const rainy: Variant = {
      variantId: 'x',
      weight: 1,
      ambienceId: 'x',
      when: { weathers: ['rain'] },
    }
    expect(matchesCondition(rainy.when, context)).toBe(false)
    expect(matchesCondition(rainy.when, { ...context, weather: 'rain' })).toBe(true)
    expect(matchesCondition(undefined, context)).toBe(true)
  })

  it('treats "no crisis" as a matchable value', () => {
    const calm = { crises: ['none'] as const }
    expect(matchesCondition(calm, context)).toBe(true)
    expect(matchesCondition(calm, { ...context, crisis: 'tired' })).toBe(false)
  })

  it('offers a different eligible set as the world changes', () => {
    const morning = IDLE_VARIANTS.filter((it) => matchesCondition(it.when, context)).map(
      (it) => it.variantId,
    )
    const night = IDLE_VARIANTS.filter((it) =>
      matchesCondition(it.when, {
        ...context,
        phase: 'night',
        weather: 'starry',
        environment: 'night_terrace',
      }),
    ).map((it) => it.variantId)
    expect(morning).not.toEqual(night)
  })

  it('avoids recently used variants while alternatives remain', () => {
    const first = selectVariant(REACTION_VARIANTS.FEED, context, empty, createRng('a'))
    expect(first).not.toBe(null)
    const recent: VariationState = {
      recentVariantIds: [first?.variantId ?? ''],
      recentSceneKeys: [],
    }
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const next = selectVariant(REACTION_VARIANTS.FEED, context, recent, createRng(seed))
      expect(next?.variantId).not.toBe(first?.variantId)
    }
  })

  it('falls back to the eligible set rather than staging nothing', () => {
    const only: readonly Variant[] = [{ variantId: 'only_one', weight: 1, ambienceId: 'only_one' }]
    const recent: VariationState = { recentVariantIds: ['only_one'], recentSceneKeys: [] }
    expect(selectVariant(only, context, recent, createRng('a'))?.variantId).toBe('only_one')
  })

  it('returns null when nothing is eligible', () => {
    const impossible: readonly Variant[] = [
      { variantId: 'never', weight: 1, ambienceId: 'never', when: { phases: ['night'] } },
    ]
    expect(selectVariant(impossible, context, empty, createRng('a'))).toBe(null)
  })

  it('keeps the recent rings bounded', () => {
    let variation = empty
    for (let index = 0; index < 100; index += 1) {
      variation = rememberVariant(variation, `v_${String(index)}`, `s_${String(index)}`, tuning)
    }
    expect(variation.recentVariantIds).toHaveLength(tuning.variation.recentVariantWindow)
    expect(variation.recentSceneKeys).toHaveLength(tuning.variation.recentSceneWindow)
  })

  it('makes the scene key depend on the environment, not only the variant', () => {
    expect(sceneKeyFor('feed_big_bite', context)).not.toBe(
      sceneKeyFor('feed_big_bite', { ...context, weather: 'rain' }),
    )
  })
})

describe('freshness metrics (spec §14.1)', () => {
  it('counts distinct transitions, not distinct timestamps', () => {
    const list = [transition(), transition({ at: '2026-08-18T00:00:00.000Z' })]
    expect(countUniqueTransitions(list)).toBe(1)
    expect(countUniqueTransitions([...list, transition({ to: 'idle_dawn_yawn' })])).toBe(2)
  })

  it('includes the staging variant in the transition signature', () => {
    expect(transitionSignature(transition())).not.toBe(
      transitionSignature(transition({ variantId: 'idle_dawn_yawn' })),
    )
  })

  it('reports 0 when every sampled scene is distinct and 1 when none is', () => {
    const distinct = [1, 2, 3, 4].map((index) => transition({ sceneKey: `scene_${String(index)}` }))
    expect(repeatedSceneRatio(distinct, 10)).toBe(0)
    const same = [1, 2, 3, 4].map(() => transition({ sceneKey: 'scene_1' }))
    expect(repeatedSceneRatio(same, 10)).toBe(0.75)
  })

  it('ignores transitions that staged no scene', () => {
    expect(repeatedSceneRatio([transition({ sceneKey: null })], 10)).toBe(0)
  })

  it('separates the narrative sample from the seconds-scale one', () => {
    const idle = [1, 2, 3, 4].map(() => transition({ sceneKey: 'idle_same' }))
    const narrative = [1, 2].map((index) =>
      transition({ type: 'weather_changed', sceneKey: `weather_${String(index)}` }),
    )
    const report = computeFreshness([...idle, ...narrative])
    expect(report.repeatedSceneRatio).toBeGreaterThan(0)
    expect(report.repeatedNarrativeSceneRatio).toBe(0)
    expect(report.transitionsByScale.seconds).toBe(4)
    expect(report.transitionsByScale.hours).toBe(2)
  })
})

describe('the same command does not always look the same (spec §12.5)', () => {
  it('stages several different reactions for a repeated FEED', () => {
    let state = initialWorldState({ seed: 'seed_test_variation', startedAt: START })
    // Move the world on first so the run spans different phases and weather.
    state = runWorld({ to: addMillis(START, 4 * MILLIS_PER_HOUR), state }).state

    const staged = new Set<string>()
    let at = state.world.worldTimeUtc
    for (let index = 0; index < 12; index += 1) {
      at = addMillis(at, 45_000)
      const input = { kind: 'event' as const, event: commandEvent(at, 'FEED') }
      const result = step(state, input, at, stepRngFor(state, input))
      state = result.state
      for (const effect of result.effects) {
        if (effect.kind === 'AMBIENCE') staged.add(effect.payload.ambienceId)
      }
    }
    expect(staged.size).toBeGreaterThan(1)
  })
})
