import { describe, expect, it } from 'vitest'

import { CHAPTER_DEFINITIONS, DIRECTOR_RULES, chapterDefinition } from './content/chapters.js'
import { DEFAULT_WORLD_TUNING } from './content/tuning.js'
import type { ContentContext } from './content/variants.js'
import { addContribution, addVote, openChoiceWindow, resolveChoice } from './choices.js'
import { createRng } from './rng.js'
import type { ChoiceDomainState } from './types.js'

const tuning = DEFAULT_WORLD_TUNING
const NOW = '2026-08-18T04:24:00.000Z'

const context: ContentContext = {
  phase: 'afternoon',
  weather: 'clear',
  environment: 'home_room',
  chapter: 'gathering',
  beat: 'turn',
  crisis: null,
  emotion: 'content',
  dominantNeed: 'play',
  growthStage: 'hatchling',
  visitor: null,
}

describe('choice windows (spec §6.4, BOARD A-9)', () => {
  it('offers A/B/C commands only when the identity gate is open', () => {
    const open = openChoiceWindow('gathering', true, NOW, tuning)
    expect(open.mode).toBe('vote')
    expect(open.options.map((it) => it.commandName)).toEqual(['VOTE_A', 'VOTE_B', 'VOTE_C'])

    const closed = openChoiceWindow('gathering', false, NOW, tuning)
    expect(closed.mode).toBe('director')
    expect(closed.options.map((it) => it.commandName)).toEqual([null, null, null])
    // Same branches on both paths: only the decision procedure differs.
    expect(closed.options.map((it) => it.choiceId)).toEqual(open.options.map((it) => it.choiceId))
  })

  it('picks the option with the most votes in vote mode', () => {
    let choice = openChoiceWindow('festival_prep', true, NOW, tuning)
    choice = addVote(choice, 'VOTE_B')
    choice = addVote(choice, 'VOTE_B')
    choice = addVote(choice, 'VOTE_C')

    const resolution = resolveChoice(choice, context, createRng('seed_test_vote'))
    expect(resolution?.method).toBe('vote')
    expect(resolution?.option.choiceId).toBe('music_practice')
    expect(resolution?.votes).toBe(2)
  })

  it('breaks a tie with the seeded RNG rather than always defaulting to A', () => {
    const choice = openChoiceWindow('gathering', true, NOW, tuning)
    const winners = new Set<string>()
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      const resolution = resolveChoice(choice, context, createRng(seed))
      if (resolution !== null) winners.add(resolution.option.choiceId)
    }
    expect(winners.size).toBeGreaterThan(1)
  })

  it('only ever picks an approved event combination in director mode', () => {
    const approved = new Set(
      CHAPTER_DEFINITIONS.flatMap((chapter) =>
        chapter.options.map((option) => option.eventCombinationId),
      ),
    )
    for (const chapter of CHAPTER_DEFINITIONS) {
      const choice = openChoiceWindow(chapter.chapterId, false, NOW, tuning)
      for (let index = 0; index < 20; index += 1) {
        const resolution = resolveChoice(choice, context, createRng(`seed_${String(index)}`))
        expect(resolution).not.toBe(null)
        expect(approved.has(resolution?.option.eventCombinationId ?? '')).toBe(true)
        expect(chapter.options.some((it) => it.choiceId === resolution?.option.choiceId)).toBe(true)
      }
    }
  })

  it('lets the non-competitive room total tilt the director, without deciding it', () => {
    const base = openChoiceWindow('gathering', false, NOW, tuning)
    const withFeed = addContribution(base, 'FEED', 500)

    const countWins = (choice: ChoiceDomainState): number => {
      let wins = 0
      for (let index = 0; index < 40; index += 1) {
        const resolution = resolveChoice(choice, context, createRng(`tilt_${String(index)}`))
        if (resolution?.option.choiceId === 'forage_garden') wins += 1
      }
      return wins
    }

    expect(countWins(withFeed)).toBeGreaterThan(countWins(base))
    // Every branch stays reachable: a room total is not a veto (spec §6.4).
    const reachable = new Set<string>()
    for (let index = 0; index < 60; index += 1) {
      const resolution = resolveChoice(withFeed, context, createRng(`reach_${String(index)}`))
      if (resolution !== null) reachable.add(resolution.option.choiceId)
    }
    expect(reachable.size).toBe(3)
  })

  it('records which director rules supported the branch', () => {
    const choice = openChoiceWindow('gathering', false, NOW, tuning)
    const rainy: ContentContext = { ...context, weather: 'rain' }
    const seen = new Set<string>()
    for (let index = 0; index < 40; index += 1) {
      const resolution = resolveChoice(choice, rainy, createRng(`rule_${String(index)}`))
      for (const ruleId of resolution?.ruleIds ?? []) seen.add(ruleId)
    }
    expect(seen.has('rule_shelter_from_rain')).toBe(true)
    for (const ruleId of seen) {
      expect(DIRECTOR_RULES.some((rule) => rule.ruleId === ruleId)).toBe(true)
    }
  })

  it('keeps vote and contribution tallies apart', () => {
    let choice = openChoiceWindow('growth_choice', true, NOW, tuning)
    choice = addVote(choice, 'VOTE_A')
    choice = addContribution(choice, 'PET', 3)
    expect(choice.voteTally).toEqual({ VOTE_A: 1 })
    expect(choice.contributionTally).toEqual({ PET: 3 })
  })
})

describe('chapter content', () => {
  it('gives every chapter exactly three branches with distinct combinations', () => {
    for (const chapter of CHAPTER_DEFINITIONS) {
      expect(chapter.options).toHaveLength(3)
      const combinations = new Set(chapter.options.map((it) => it.eventCombinationId))
      expect(combinations.size).toBe(3)
      expect(chapterDefinition(chapter.chapterId)).toBe(chapter)
    }
  })

  it('refuses an unknown chapter instead of inventing content', () => {
    // @ts-expect-error — the chapter id vocabulary is closed at the type level.
    expect(() => chapterDefinition('not_a_chapter')).toThrow(/unknown chapter/)
  })
})
