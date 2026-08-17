import type { Identifier, TextKey } from '@vl/contract'

import type { CareCommand, ChapterId, EnvironmentId, MissionId } from '../types.js'
import type { VariantCondition } from './variants.js'

/**
 * Day-scale content: the completed chapter with a start, a change and an end
 * that spec §6.2 makes a Gate 3 requirement, and the branch that chapter takes.
 *
 * The branch has two approved paths (spec §6.4, BOARD A-9):
 * - identity gate **open**: an A/B/C vote window decides it;
 * - identity gate **closed** (V1 default): no per-user branch vote exists, so
 *   the director picks among *approved event combinations* using the rules
 *   below, informed by the non-competitive room total of free commands. No
 *   per-user fairness is claimed in that mode.
 *
 * Both paths choose from the same option list, so the chapter content does not
 * fork with the flag — only the decision procedure does.
 */

export interface ChapterOption {
  readonly choiceId: Identifier
  readonly labelKey: TextKey
  /** The approved event combination this branch runs (spec §6.2, §6.4). */
  readonly eventCombinationId: Identifier
  /**
   * Free command whose room total favours this branch while the identity gate is
   * closed. It is a total, never a per-user vote (spec §6.4).
   */
  readonly contributionCommand: CareCommand
  readonly ambienceId: Identifier
  readonly environmentId: EnvironmentId
  /** Mission the rest of the chapter leans towards after this branch. */
  readonly missionBias: MissionId
}

export interface ChapterDefinition {
  readonly chapterId: ChapterId
  readonly titleKey: TextKey
  readonly weight: number
  readonly setupAmbienceId: Identifier
  readonly turnAmbienceId: Identifier
  readonly resolutionAmbienceId: Identifier
  /** Exactly three options so the A/B/C vote path has one command each (§7.1). */
  readonly options: readonly [ChapterOption, ChapterOption, ChapterOption]
}

export const CHAPTER_DEFINITIONS: readonly ChapterDefinition[] = [
  {
    chapterId: 'gathering',
    titleKey: 'chapter.gathering',
    weight: 3,
    setupAmbienceId: 'chapter_gathering_setup',
    turnAmbienceId: 'chapter_gathering_turn',
    resolutionAmbienceId: 'chapter_gathering_resolution',
    options: [
      {
        choiceId: 'forage_garden',
        labelKey: 'choice.gathering.forage_garden',
        eventCombinationId: 'combo_forage_garden',
        contributionCommand: 'FEED',
        ambienceId: 'branch_forage_garden',
        environmentId: 'garden',
        missionBias: 'gather_ingredients',
      },
      {
        choiceId: 'river_walk',
        labelKey: 'choice.gathering.river_walk',
        eventCombinationId: 'combo_river_walk',
        contributionCommand: 'PLAY',
        ambienceId: 'branch_river_walk',
        environmentId: 'riverside',
        missionBias: 'chase_the_ribbon',
      },
      {
        choiceId: 'rest_indoors',
        labelKey: 'choice.gathering.rest_indoors',
        eventCombinationId: 'combo_rest_indoors',
        contributionCommand: 'PET',
        ambienceId: 'branch_rest_indoors',
        environmentId: 'home_room',
        missionBias: 'quiet_company',
      },
    ],
  },
  {
    chapterId: 'festival_prep',
    titleKey: 'chapter.festival_prep',
    weight: 3,
    setupAmbienceId: 'chapter_festival_setup',
    turnAmbienceId: 'chapter_festival_turn',
    resolutionAmbienceId: 'chapter_festival_resolution',
    options: [
      {
        choiceId: 'lantern_row',
        labelKey: 'choice.festival_prep.lantern_row',
        eventCombinationId: 'combo_lantern_row',
        contributionCommand: 'PLAY',
        ambienceId: 'branch_lantern_row',
        environmentId: 'night_terrace',
        missionBias: 'hang_the_lanterns',
      },
      {
        choiceId: 'music_practice',
        labelKey: 'choice.festival_prep.music_practice',
        eventCombinationId: 'combo_music_practice',
        contributionCommand: 'PET',
        ambienceId: 'branch_music_practice',
        environmentId: 'home_room',
        missionBias: 'quiet_company',
      },
      {
        choiceId: 'night_stalls',
        labelKey: 'choice.festival_prep.night_stalls',
        eventCombinationId: 'combo_night_stalls',
        contributionCommand: 'FEED',
        ambienceId: 'branch_night_stalls',
        environmentId: 'garden',
        missionBias: 'share_a_meal',
      },
    ],
  },
  {
    chapterId: 'growth_choice',
    titleKey: 'chapter.growth_choice',
    weight: 2,
    setupAmbienceId: 'chapter_growth_setup',
    turnAmbienceId: 'chapter_growth_turn',
    resolutionAmbienceId: 'chapter_growth_resolution',
    options: [
      {
        choiceId: 'grow_swift',
        labelKey: 'choice.growth_choice.grow_swift',
        eventCombinationId: 'combo_grow_swift',
        contributionCommand: 'PLAY',
        ambienceId: 'branch_grow_swift',
        environmentId: 'riverside',
        missionBias: 'chase_the_ribbon',
      },
      {
        choiceId: 'grow_gentle',
        labelKey: 'choice.growth_choice.grow_gentle',
        eventCombinationId: 'combo_grow_gentle',
        contributionCommand: 'PET',
        ambienceId: 'branch_grow_gentle',
        environmentId: 'home_room',
        missionBias: 'quiet_company',
      },
      {
        choiceId: 'grow_curious',
        labelKey: 'choice.growth_choice.grow_curious',
        eventCombinationId: 'combo_grow_curious',
        contributionCommand: 'FEED',
        ambienceId: 'branch_grow_curious',
        environmentId: 'garden',
        missionBias: 'gather_ingredients',
      },
    ],
  },
]

export function chapterDefinition(chapterId: ChapterId): ChapterDefinition {
  const definition = CHAPTER_DEFINITIONS.find((it) => it.chapterId === chapterId)
  if (definition === undefined) throw new Error(`unknown chapter: ${chapterId}`)
  return definition
}

/**
 * The director's approved combination rules for the gate-closed path (spec §6.4:
 * "디렉터가 승인된 사건 조합으로 진행"). A rule only ever *weights* an already
 * approved option; it can never invent one, so every branch the world can take
 * is in `CHAPTER_DEFINITIONS` above and reviewable as content.
 */
export interface DirectorRule {
  readonly ruleId: Identifier
  readonly prefers: Identifier
  readonly weight: number
  readonly when?: VariantCondition
}

export const DIRECTOR_RULES: readonly DirectorRule[] = [
  {
    ruleId: 'rule_shelter_from_rain',
    prefers: 'combo_rest_indoors',
    weight: 4,
    when: { weathers: ['rain'] },
  },
  {
    ruleId: 'rule_music_when_wet',
    prefers: 'combo_music_practice',
    weight: 4,
    when: { weathers: ['rain', 'cloudy'] },
  },
  {
    ruleId: 'rule_forage_when_hungry',
    prefers: 'combo_forage_garden',
    weight: 4,
    when: { dominantNeeds: ['hungry'] },
  },
  {
    ruleId: 'rule_stalls_when_hungry',
    prefers: 'combo_night_stalls',
    weight: 3,
    when: { dominantNeeds: ['hungry'] },
  },
  {
    ruleId: 'rule_river_when_playful',
    prefers: 'combo_river_walk',
    weight: 4,
    when: { dominantNeeds: ['play'], crises: ['none'] },
  },
  {
    ruleId: 'rule_lanterns_at_night',
    prefers: 'combo_lantern_row',
    weight: 4,
    when: { phases: ['evening', 'night'] },
  },
  {
    ruleId: 'rule_quiet_when_in_crisis',
    prefers: 'combo_rest_indoors',
    weight: 5,
    when: { crises: ['tired', 'needs_help', 'sleeping'] },
  },
  {
    ruleId: 'rule_gentle_growth_when_tired',
    prefers: 'combo_grow_gentle',
    weight: 4,
    when: { crises: ['tired', 'needs_help', 'sleeping'] },
  },
  {
    ruleId: 'rule_swift_growth_when_clear',
    prefers: 'combo_grow_swift',
    weight: 4,
    when: { weathers: ['clear', 'wind'], crises: ['none'] },
  },
  {
    ruleId: 'rule_curious_growth_with_visitor',
    prefers: 'combo_grow_curious',
    weight: 4,
    when: { visitorPresent: true },
  },
]
