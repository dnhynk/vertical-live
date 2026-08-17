import type { IsoUtcInstant } from '@vl/contract'

import { chapterDefinition, DIRECTOR_RULES, type ChapterDefinition } from './content/chapters.js'
import { DEFAULT_WORLD_TUNING, type WorldTuning } from './content/tuning.js'
import { matchesCondition, type ContentContext } from './content/variants.js'
import type { Rng } from './rng.js'
import { addMillis } from './time.js'
import {
  VOTE_COMMANDS,
  type CareCommand,
  type ChapterId,
  type ChoiceDomainState,
  type ChoiceOption,
  type VoteCommand,
} from './types.js'

/**
 * The branch procedure of spec §6.4, in both approved shapes (BOARD A-9).
 *
 * `vote` mode exists only when the identity feature gate is open: a per-user
 * A/B/C vote is a per-user judgement, and spec §6.4 forbids claiming one while
 * the gate is closed. `director` mode is the V1 default: no branch vote is
 * offered, the director decides among *approved event combinations*, and the
 * room's free commands are counted non-competitively as one of the inputs to
 * that decision. Neither mode can invent a branch — both pick from the options
 * declared in the chapter definition.
 */

export function choiceOptionsFor(
  chapter: ChapterDefinition,
  gateOpen: boolean,
): readonly ChoiceOption[] {
  return chapter.options.map((option, index) => ({
    choiceId: option.choiceId,
    labelKey: option.labelKey,
    // Without the gate there is no vote command to show: the screen previews the
    // decision instead of soliciting one (spec §6.4).
    commandName: gateOpen ? (VOTE_COMMANDS[index] ?? null) : null,
    eventCombinationId: option.eventCombinationId,
  }))
}

export function openChoiceWindow(
  chapterId: ChapterId,
  gateOpen: boolean,
  now: IsoUtcInstant,
  tuning: WorldTuning,
): ChoiceDomainState {
  const chapter = chapterDefinition(chapterId)
  return {
    choiceSetId: chapter.chapterId,
    mode: gateOpen ? 'vote' : 'director',
    options: choiceOptionsFor(chapter, gateOpen),
    opensAt: now,
    closesAt: addMillis(now, tuning.choice.windowMs),
    voteTally: {},
    contributionTally: {},
  }
}

/** Adds one anonymous vote. Only reachable in `vote` mode (spec §6.4). */
export function addVote(choice: ChoiceDomainState, command: VoteCommand): ChoiceDomainState {
  return {
    ...choice,
    voteTally: { ...choice.voteTally, [command]: (choice.voteTally[command] ?? 0) + 1 },
  }
}

/** Adds free care contributions to the non-competitive room total (spec §6.4). */
export function addContribution(
  choice: ChoiceDomainState,
  command: CareCommand,
  count: number,
): ChoiceDomainState {
  return {
    ...choice,
    contributionTally: {
      ...choice.contributionTally,
      [command]: (choice.contributionTally[command] ?? 0) + Math.max(1, Math.trunc(count)),
    },
  }
}

export interface ChoiceResolution {
  readonly option: ChoiceOption
  readonly method: 'vote' | 'director'
  /** Director rules that supported the winning combination, for the audit trail. */
  readonly ruleIds: readonly string[]
  /** Votes the winner had, in `vote` mode. */
  readonly votes: number
}

function resolveByVote(choice: ChoiceDomainState, rng: Rng): ChoiceResolution | null {
  const scored = choice.options.map((option) => ({
    option,
    votes: option.commandName === null ? 0 : (choice.voteTally[option.commandName] ?? 0),
  }))
  const best = Math.max(...scored.map((entry) => entry.votes))
  const leaders = scored.filter((entry) => entry.votes === best)
  // A tie (including "nobody voted") is broken by the seeded RNG rather than by
  // option order, so the branch does not silently default to A every time.
  const winner = leaders.length === 1 ? leaders[0] : rng.pick(leaders)
  if (winner === undefined || winner === null) return null
  return { option: winner.option, method: 'vote', ruleIds: [], votes: winner.votes }
}

function resolveByDirector(
  choice: ChoiceDomainState,
  context: ContentContext,
  rng: Rng,
  tuning: WorldTuning,
): ChoiceResolution | null {
  const matching = DIRECTOR_RULES.filter((rule) => matchesCondition(rule.when, context))
  const scored = choice.options.map((option) => {
    const rules = matching.filter((rule) => rule.prefers === option.eventCombinationId)
    const chapter = chapterDefinition(choice.choiceSetId)
    const definition = chapter.options.find((it) => it.choiceId === option.choiceId)
    const contributions =
      definition === undefined ? 0 : (choice.contributionTally[definition.contributionCommand] ?? 0)
    return {
      option,
      rules,
      // Base 1 keeps every approved combination reachable; the director rules and
      // the room's damped, capped total only tilt the draw (see the tuning note).
      weight:
        1 +
        rules.reduce((sum, rule) => sum + rule.weight, 0) +
        Math.min(tuning.choice.contributionWeightCap, Math.sqrt(contributions)),
    }
  })
  const winner = rng.pickWeighted(scored, (entry) => entry.weight)
  if (winner === null) return null
  return {
    option: winner.option,
    method: 'director',
    ruleIds: winner.rules.map((rule) => rule.ruleId),
    votes: 0,
  }
}

export function resolveChoice(
  choice: ChoiceDomainState,
  context: ContentContext,
  rng: Rng,
  tuning: WorldTuning = DEFAULT_WORLD_TUNING,
): ChoiceResolution | null {
  return choice.mode === 'vote'
    ? resolveByVote(choice, rng)
    : resolveByDirector(choice, context, rng, tuning)
}
