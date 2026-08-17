import { describe, expect, it } from 'vitest'

import { DEFAULT_WORLD_TUNING } from './content/tuning.js'
import {
  addBond,
  addGrowth,
  deriveEmotion,
  dominantNeed,
  evaluateCrisis,
  growthStageOf,
  growthTargetFor,
  integrateNeeds,
  lifeStageOf,
} from './creature.js'
import { GROWTH_STAGES, NEED_IDS, type CreatureDomainState } from './types.js'

const tuning = DEFAULT_WORLD_TUNING

function creature(overrides: Partial<CreatureDomainState> = {}): CreatureDomainState {
  return {
    creatureId: 'creature_1',
    growthStageIndex: 0,
    needs: { hungry: 0.2, play: 0.2, affection: 0.2, rest: 0.1 },
    needsUpdatedAt: '2026-08-17T00:00:00.000Z',
    emotionId: 'content',
    bond: { current: 0, target: tuning.growth.bondTarget },
    growth: { current: 0, target: growthTargetFor(0, tuning) },
    crisis: null,
    crisisSince: null,
    ...overrides,
  }
}

const hoursLater = (hours: number): string =>
  new Date(Date.parse('2026-08-17T00:00:00.000Z') + hours * 3_600_000).toISOString()

describe('need pressure (spec §6.3)', () => {
  it('rises with elapsed time and stays inside [0, 1]', () => {
    const after = integrateNeeds(creature(), hoursLater(2), tuning)
    expect(after.needs.hungry).toBeCloseTo(0.2 + 2 * tuning.needs.rates.hungry.awakePerHour, 6)
    for (const need of NEED_IDS) {
      expect(after.needs[need]).toBeGreaterThanOrEqual(0)
      expect(after.needs[need]).toBeLessThanOrEqual(1)
    }
  })

  it('clamps at the ceiling however long the world is left alone', () => {
    const after = integrateNeeds(creature(), hoursLater(1000), tuning)
    for (const need of NEED_IDS) expect(after.needs[need]).toBeLessThanOrEqual(1)
  })

  it('is a function of elapsed time, so one delivery equals many (coalesce)', () => {
    const once = integrateNeeds(creature(), hoursLater(3), tuning)
    let stepwise = creature()
    for (const hour of [1, 2, 3]) stepwise = integrateNeeds(stepwise, hoursLater(hour), tuning)
    for (const need of NEED_IDS) expect(stepwise.needs[need]).toBeCloseTo(once.needs[need], 9)
  })

  it('relieves pressure by itself while in a crisis (zero-viewer recovery)', () => {
    const distressed = creature({
      needs: { hungry: 0.95, play: 0.3, affection: 0.3, rest: 0.3 },
      crisis: 'tired',
    })
    const after = integrateNeeds(distressed, hoursLater(2), tuning)
    expect(after.needs.hungry).toBeLessThan(distressed.needs.hungry)
  })
})

describe('crisis states (spec §6.3)', () => {
  it('enters `tired` when one need passes the threshold', () => {
    const needs = { hungry: 0.85, play: 0.2, affection: 0.2, rest: 0.2 }
    expect(evaluateCrisis(needs, 'afternoon', null, tuning)).toBe('tired')
  })

  it('escalates to `needs_help` when two needs are high', () => {
    const needs = { hungry: 0.85, play: 0.9, affection: 0.2, rest: 0.2 }
    expect(evaluateCrisis(needs, 'afternoon', null, tuning)).toBe('needs_help')
  })

  it('sleeps at night and wakes once rested', () => {
    const tiredOfBeingAwake = { hungry: 0.2, play: 0.2, affection: 0.2, rest: 0.6 }
    expect(evaluateCrisis(tiredOfBeingAwake, 'night', null, tuning)).toBe('sleeping')
    const rested = { hungry: 0.2, play: 0.2, affection: 0.2, rest: 0.05 }
    expect(evaluateCrisis(rested, 'night', 'sleeping', tuning)).toBe(null)
  })

  it('holds a crisis with hysteresis instead of flapping at the threshold', () => {
    const justUnder = { hungry: 0.7, play: 0.2, affection: 0.2, rest: 0.2 }
    expect(evaluateCrisis(justUnder, 'afternoon', null, tuning)).toBe(null)
    expect(evaluateCrisis(justUnder, 'afternoon', 'tired', tuning)).toBe('tired')
  })

  it('recovers to no crisis once pressure falls, and never to a worse state', () => {
    const calm = { hungry: 0.1, play: 0.1, affection: 0.1, rest: 0.1 }
    expect(evaluateCrisis(calm, 'afternoon', 'needs_help', tuning)).toBe(null)
    // There is no state below `needs_help`: the union has three members only.
    expect(evaluateCrisis(calm, 'afternoon', 'tired', tuning)).toBe(null)
  })

  it('derives an emotion for every crisis', () => {
    const calm = { hungry: 0.1, play: 0.1, affection: 0.1, rest: 0.1 }
    expect(deriveEmotion(calm, 'sleeping')).toBe('sleepy')
    expect(deriveEmotion(calm, 'tired')).toBe('weary')
    expect(deriveEmotion(calm, 'needs_help')).toBe('worried')
    expect(deriveEmotion(calm, null)).toBe('joyful')
    expect(deriveEmotion({ hungry: 0.2, play: 0.2, affection: 0.7, rest: 0.2 }, null)).toBe(
      'lonely',
    )
  })
})

describe('growth (spec §2.3, §6.3)', () => {
  it('advances a stage when the target is met and carries the remainder', () => {
    const start = creature()
    const result = addGrowth(start, growthTargetFor(0, tuning) + 5, tuning)
    expect(result.advancedFrom).toBe('egg')
    expect(result.creature.growthStageIndex).toBe(1)
    expect(result.creature.growth.current).toBeCloseTo(5, 6)
    expect(result.creature.growth.target).toBe(growthTargetFor(1, tuning))
  })

  it('never regresses: negative growth is ignored', () => {
    const advanced = creature({ growthStageIndex: 2, growth: { current: 40, target: 240 } })
    const result = addGrowth(advanced, -1000, tuning)
    expect(result.creature).toBe(advanced)
    expect(result.creature.growthStageIndex).toBe(2)
  })

  it('saturates at the final stage instead of wrapping or dying', () => {
    const last = creature({
      growthStageIndex: GROWTH_STAGES.length - 1,
      growth: { current: 0, target: growthTargetFor(GROWTH_STAGES.length - 1, tuning) },
    })
    const result = addGrowth(last, 10_000, tuning)
    expect(result.advancedFrom).toBe(null)
    expect(result.creature.growthStageIndex).toBe(GROWTH_STAGES.length - 1)
    expect(result.creature.growth.current).toBe(result.creature.growth.target)
  })

  it('caps bond at its target', () => {
    const result = addBond(creature(), tuning.growth.bondTarget * 3)
    expect(result.bond.current).toBe(result.bond.target)
  })

  it('maps stage index to a growth and a life stage', () => {
    expect(growthStageOf(0)).toBe('egg')
    expect(growthStageOf(99)).toBe(GROWTH_STAGES[GROWTH_STAGES.length - 1])
    expect(lifeStageOf(0)).toBe('egg')
    expect(lifeStageOf(3)).toBe('adult')
  })
})

describe('dominant need', () => {
  it('picks the need under the most pressure', () => {
    expect(dominantNeed({ hungry: 0.1, play: 0.9, affection: 0.2, rest: 0.3 })).toBe('play')
  })
})
