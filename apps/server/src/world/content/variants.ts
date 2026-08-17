import type { Identifier } from '@vl/contract'

import type {
  CareCommand,
  ChapterBeat,
  ChapterId,
  CrisisId,
  EmotionId,
  EnvironmentId,
  GrowthStage,
  MissionId,
  NeedId,
  VisitorId,
  WeatherId,
  WorldPhaseId,
} from '../types.js'

/**
 * The variant catalogue: what the world can stage, and under which conditions.
 *
 * Spec §12.5 forbids "the same scene with different numbers": the same command
 * must be able to produce different staging depending on state, chapter and
 * environment. That is why every entry carries a `when` condition instead of a
 * flat weight table — the *set of eligible variants* changes with the world, and
 * `variation.ts` then avoids the ones used most recently.
 *
 * All ids are lower-case identifiers (the contract's `IdentifierSchema`) and all
 * copy lives behind i18n keys, so no display string is defined here (spec §5.3,
 * §12.3). The Japanese wording is added by the renderer tasks (T5/T14) with
 * `nativeReview: pending`.
 */

export interface VariantCondition {
  readonly phases?: readonly WorldPhaseId[]
  readonly weathers?: readonly WeatherId[]
  readonly environments?: readonly EnvironmentId[]
  readonly chapters?: readonly ChapterId[]
  readonly beats?: readonly ChapterBeat[]
  /** `'none'` matches "not in a crisis". */
  readonly crises?: readonly (CrisisId | 'none')[]
  readonly emotions?: readonly EmotionId[]
  readonly dominantNeeds?: readonly NeedId[]
  readonly growthStages?: readonly GrowthStage[]
  readonly visitorPresent?: boolean
}

export interface Variant {
  readonly variantId: Identifier
  readonly weight: number
  readonly when?: VariantCondition
  /** Staging id handed to the renderer through an `AMBIENCE` effect. */
  readonly ambienceId: Identifier
}

/** The world facts a variant condition is matched against. */
export interface ContentContext {
  readonly phase: WorldPhaseId
  readonly weather: WeatherId
  readonly environment: EnvironmentId
  readonly chapter: ChapterId
  readonly beat: ChapterBeat
  readonly crisis: CrisisId | null
  readonly emotion: EmotionId
  readonly dominantNeed: NeedId
  readonly growthStage: GrowthStage
  readonly visitor: VisitorId | null
}

function includes<T>(allowed: readonly T[] | undefined, value: T): boolean {
  return allowed === undefined || allowed.includes(value)
}

export function matchesCondition(
  condition: VariantCondition | undefined,
  context: ContentContext,
): boolean {
  if (condition === undefined) return true
  if (!includes(condition.phases, context.phase)) return false
  if (!includes(condition.weathers, context.weather)) return false
  if (!includes(condition.environments, context.environment)) return false
  if (!includes(condition.chapters, context.chapter)) return false
  if (!includes(condition.beats, context.beat)) return false
  if (!includes(condition.crises, context.crisis ?? 'none')) return false
  if (!includes(condition.emotions, context.emotion)) return false
  if (!includes(condition.dominantNeeds, context.dominantNeed)) return false
  if (!includes(condition.growthStages, context.growthStage)) return false
  if (condition.visitorPresent !== undefined) {
    if (condition.visitorPresent !== (context.visitor !== null)) return false
  }
  return true
}

/** Seconds-scale idle life: what the room shows when nobody typed (spec §6.2). */
export const IDLE_VARIANTS: readonly Variant[] = [
  { variantId: 'idle_slow_breath', weight: 3, ambienceId: 'idle_slow_breath' },
  {
    variantId: 'idle_sun_stretch',
    weight: 4,
    ambienceId: 'idle_sun_stretch',
    when: { phases: ['morning'], weathers: ['clear'], crises: ['none'] },
  },
  {
    variantId: 'idle_window_watch',
    weight: 4,
    ambienceId: 'idle_window_watch',
    when: { weathers: ['rain'], crises: ['none'] },
  },
  {
    variantId: 'idle_wind_ears',
    weight: 3,
    ambienceId: 'idle_wind_ears',
    when: { weathers: ['wind'] },
  },
  {
    variantId: 'idle_star_gaze',
    weight: 4,
    ambienceId: 'idle_star_gaze',
    when: { phases: ['night'], weathers: ['starry', 'clear'], crises: ['none'] },
  },
  {
    variantId: 'idle_curl_sleep',
    weight: 6,
    ambienceId: 'idle_curl_sleep',
    when: { crises: ['sleeping'] },
  },
  {
    variantId: 'idle_tummy_rumble',
    weight: 4,
    ambienceId: 'idle_tummy_rumble',
    when: { dominantNeeds: ['hungry'] },
  },
  {
    variantId: 'idle_toy_nudge',
    weight: 4,
    ambienceId: 'idle_toy_nudge',
    when: { dominantNeeds: ['play'], crises: ['none'] },
  },
  {
    variantId: 'idle_door_glance',
    weight: 4,
    ambienceId: 'idle_door_glance',
    when: { dominantNeeds: ['affection'] },
  },
  {
    variantId: 'idle_slow_blink',
    weight: 3,
    ambienceId: 'idle_slow_blink',
    when: { crises: ['tired'] },
  },
  {
    variantId: 'idle_ask_for_help',
    weight: 5,
    ambienceId: 'idle_ask_for_help',
    when: { crises: ['needs_help'] },
  },
  {
    variantId: 'idle_garden_sniff',
    weight: 3,
    ambienceId: 'idle_garden_sniff',
    when: { environments: ['garden'], crises: ['none'] },
  },
  {
    variantId: 'idle_river_paddle',
    weight: 3,
    ambienceId: 'idle_river_paddle',
    when: { environments: ['riverside'], crises: ['none'] },
  },
  {
    variantId: 'idle_lantern_shadow',
    weight: 3,
    ambienceId: 'idle_lantern_shadow',
    when: { environments: ['night_terrace'] },
  },
  {
    variantId: 'idle_visitor_peek',
    weight: 5,
    ambienceId: 'idle_visitor_peek',
    when: { visitorPresent: true },
  },
  {
    variantId: 'idle_dawn_yawn',
    weight: 3,
    ambienceId: 'idle_dawn_yawn',
    when: { phases: ['dawn'] },
  },
  {
    variantId: 'idle_festival_hum',
    weight: 4,
    ambienceId: 'idle_festival_hum',
    when: { chapters: ['festival_prep'], crises: ['none'] },
  },
  {
    variantId: 'idle_basket_check',
    weight: 4,
    ambienceId: 'idle_basket_check',
    when: { chapters: ['gathering'], crises: ['none'] },
  },
  {
    variantId: 'idle_growth_dream',
    weight: 4,
    ambienceId: 'idle_growth_dream',
    when: { chapters: ['growth_choice'] },
  },
]

/**
 * Reactions to the three free care commands (spec §7.1). Each command has
 * several stagings whose eligibility depends on the creature's state, the
 * weather and the chapter — this is the §12.5 requirement in data form.
 */
export const REACTION_VARIANTS: Readonly<Record<CareCommand, readonly Variant[]>> = {
  FEED: [
    { variantId: 'feed_polite_nibble', weight: 3, ambienceId: 'feed_polite_nibble' },
    {
      variantId: 'feed_big_bite',
      weight: 5,
      ambienceId: 'feed_big_bite',
      when: { dominantNeeds: ['hungry'] },
    },
    {
      variantId: 'feed_sleepy_taste',
      weight: 4,
      ambienceId: 'feed_sleepy_taste',
      when: { crises: ['sleeping', 'tired'] },
    },
    {
      variantId: 'feed_rain_share',
      weight: 4,
      ambienceId: 'feed_rain_share',
      when: { weathers: ['rain'] },
    },
    {
      variantId: 'feed_picnic_bite',
      weight: 4,
      ambienceId: 'feed_picnic_bite',
      when: { environments: ['garden', 'riverside'], phases: ['morning', 'afternoon'] },
    },
    {
      variantId: 'feed_festival_snack',
      weight: 4,
      ambienceId: 'feed_festival_snack',
      when: { chapters: ['festival_prep'] },
    },
    {
      variantId: 'feed_grateful_bow',
      weight: 3,
      ambienceId: 'feed_grateful_bow',
      when: { crises: ['needs_help'] },
    },
  ],
  PLAY: [
    { variantId: 'play_short_hop', weight: 3, ambienceId: 'play_short_hop' },
    {
      variantId: 'play_ribbon_chase',
      weight: 5,
      ambienceId: 'play_ribbon_chase',
      when: { dominantNeeds: ['play'], crises: ['none'] },
    },
    {
      variantId: 'play_puddle_splash',
      weight: 4,
      ambienceId: 'play_puddle_splash',
      when: { weathers: ['rain'] },
    },
    {
      variantId: 'play_wind_glide',
      weight: 4,
      ambienceId: 'play_wind_glide',
      when: { weathers: ['wind'] },
    },
    {
      variantId: 'play_quiet_roll',
      weight: 3,
      ambienceId: 'play_quiet_roll',
      when: { crises: ['tired', 'sleeping'] },
    },
    {
      variantId: 'play_star_chase',
      weight: 4,
      ambienceId: 'play_star_chase',
      when: { phases: ['night'], environments: ['night_terrace'] },
    },
    {
      variantId: 'play_visitor_tag',
      weight: 5,
      ambienceId: 'play_visitor_tag',
      when: { visitorPresent: true },
    },
  ],
  PET: [
    { variantId: 'pet_soft_lean', weight: 3, ambienceId: 'pet_soft_lean' },
    {
      variantId: 'pet_happy_hum',
      weight: 5,
      ambienceId: 'pet_happy_hum',
      when: { dominantNeeds: ['affection'] },
    },
    {
      variantId: 'pet_sleepy_purr',
      weight: 4,
      ambienceId: 'pet_sleepy_purr',
      when: { crises: ['sleeping'] },
    },
    {
      variantId: 'pet_calm_down',
      weight: 5,
      ambienceId: 'pet_calm_down',
      when: { crises: ['needs_help', 'tired'] },
    },
    {
      variantId: 'pet_dawn_nuzzle',
      weight: 3,
      ambienceId: 'pet_dawn_nuzzle',
      when: { phases: ['dawn', 'morning'] },
    },
    {
      variantId: 'pet_lantern_lean',
      weight: 4,
      ambienceId: 'pet_lantern_lean',
      when: { environments: ['night_terrace'] },
    },
  ],
}

export interface WeatherVariant extends Variant {
  readonly weatherId: WeatherId
}

/** Hours-scale weather changes (spec §6.2 "수시간" row). */
export const WEATHER_VARIANTS: readonly WeatherVariant[] = [
  { variantId: 'weather_clear_open', weight: 4, weatherId: 'clear', ambienceId: 'weather_clear' },
  {
    variantId: 'weather_cloud_roll',
    weight: 3,
    weatherId: 'cloudy',
    ambienceId: 'weather_cloudy',
  },
  {
    variantId: 'weather_rain_soft',
    weight: 3,
    weatherId: 'rain',
    ambienceId: 'weather_rain',
    when: { phases: ['dawn', 'morning', 'afternoon', 'evening'] },
  },
  { variantId: 'weather_wind_rise', weight: 2, weatherId: 'wind', ambienceId: 'weather_wind' },
  {
    variantId: 'weather_star_clear',
    weight: 4,
    weatherId: 'starry',
    ambienceId: 'weather_starry',
    when: { phases: ['night'] },
  },
]

export interface VisitorVariant extends Variant {
  readonly visitorId: VisitorId
}

/** Hours-scale visitors (spec §6.2 "수시간" row). */
export const VISITOR_VARIANTS: readonly VisitorVariant[] = [
  {
    variantId: 'visitor_postal_bird',
    weight: 4,
    visitorId: 'postal_bird',
    ambienceId: 'visitor_postal_bird',
    when: { phases: ['morning', 'afternoon'] },
  },
  {
    variantId: 'visitor_lantern_moth',
    weight: 4,
    visitorId: 'lantern_moth',
    ambienceId: 'visitor_lantern_moth',
    when: { phases: ['evening', 'night'] },
  },
  {
    variantId: 'visitor_garden_cat',
    weight: 3,
    visitorId: 'garden_cat',
    ambienceId: 'visitor_garden_cat',
    when: { weathers: ['clear', 'cloudy', 'wind'] },
  },
  {
    variantId: 'visitor_wandering_tinker',
    weight: 2,
    visitorId: 'wandering_tinker',
    ambienceId: 'visitor_wandering_tinker',
    when: { chapters: ['gathering', 'festival_prep'] },
  },
]

export interface MissionVariant extends Variant {
  readonly missionId: MissionId
  /** Care command that moves this mission forward. */
  readonly command: CareCommand
}

/** Minutes-scale goals (spec §6.2 "수분" row: 배고픔 해결·놀이 목표). */
export const MISSION_VARIANTS: readonly MissionVariant[] = [
  {
    variantId: 'mission_meal_together',
    weight: 5,
    missionId: 'share_a_meal',
    command: 'FEED',
    ambienceId: 'mission_meal_together',
    when: { dominantNeeds: ['hungry'] },
  },
  {
    variantId: 'mission_meal_picnic',
    weight: 3,
    missionId: 'share_a_meal',
    command: 'FEED',
    ambienceId: 'mission_meal_picnic',
    when: { environments: ['garden', 'riverside'] },
  },
  {
    variantId: 'mission_ribbon_chase',
    weight: 5,
    missionId: 'chase_the_ribbon',
    command: 'PLAY',
    ambienceId: 'mission_ribbon_chase',
    when: { dominantNeeds: ['play'], crises: ['none'] },
  },
  {
    variantId: 'mission_ribbon_windy',
    weight: 3,
    missionId: 'chase_the_ribbon',
    command: 'PLAY',
    ambienceId: 'mission_ribbon_windy',
    when: { weathers: ['wind'] },
  },
  {
    variantId: 'mission_quiet_company',
    weight: 5,
    missionId: 'quiet_company',
    command: 'PET',
    ambienceId: 'mission_quiet_company',
    when: { dominantNeeds: ['affection', 'rest'] },
  },
  {
    variantId: 'mission_quiet_night',
    weight: 4,
    missionId: 'quiet_company',
    command: 'PET',
    ambienceId: 'mission_quiet_night',
    when: { phases: ['night', 'evening'] },
  },
  {
    variantId: 'mission_gather_basket',
    weight: 5,
    missionId: 'gather_ingredients',
    command: 'FEED',
    ambienceId: 'mission_gather_basket',
    when: { chapters: ['gathering'] },
  },
  {
    variantId: 'mission_gather_river',
    weight: 4,
    missionId: 'gather_ingredients',
    command: 'PLAY',
    ambienceId: 'mission_gather_river',
    when: { chapters: ['gathering'], environments: ['riverside'] },
  },
  {
    variantId: 'mission_hang_lanterns',
    weight: 5,
    missionId: 'hang_the_lanterns',
    command: 'PLAY',
    ambienceId: 'mission_hang_lanterns',
    when: { chapters: ['festival_prep'] },
  },
  {
    variantId: 'mission_lantern_calm',
    weight: 4,
    missionId: 'hang_the_lanterns',
    command: 'PET',
    ambienceId: 'mission_lantern_calm',
    when: { chapters: ['festival_prep'], phases: ['evening', 'night'] },
  },
  {
    variantId: 'mission_rest_watch',
    weight: 4,
    missionId: 'quiet_company',
    command: 'PET',
    ambienceId: 'mission_rest_watch',
    when: { crises: ['tired', 'needs_help', 'sleeping'] },
  },
]

/** Staging for entering and leaving the recoverable crisis states (spec §6.3). */
export const CRISIS_ENTER_VARIANTS: Readonly<Record<CrisisId, readonly Variant[]>> = {
  sleeping: [
    { variantId: 'crisis_sleep_curl', weight: 3, ambienceId: 'crisis_sleep_curl' },
    {
      variantId: 'crisis_sleep_star',
      weight: 3,
      ambienceId: 'crisis_sleep_star',
      when: { weathers: ['starry', 'clear'] },
    },
  ],
  tired: [
    { variantId: 'crisis_tired_slump', weight: 3, ambienceId: 'crisis_tired_slump' },
    {
      variantId: 'crisis_tired_rain',
      weight: 3,
      ambienceId: 'crisis_tired_rain',
      when: { weathers: ['rain', 'cloudy'] },
    },
  ],
  needs_help: [
    { variantId: 'crisis_help_call', weight: 3, ambienceId: 'crisis_help_call' },
    {
      variantId: 'crisis_help_huddle',
      weight: 3,
      ambienceId: 'crisis_help_huddle',
      when: { phases: ['evening', 'night'] },
    },
  ],
}

export const CRISIS_RECOVERY_VARIANTS: Readonly<Record<CrisisId, readonly Variant[]>> = {
  sleeping: [
    { variantId: 'recover_wake_stretch', weight: 3, ambienceId: 'recover_wake_stretch' },
    {
      variantId: 'recover_wake_dawn',
      weight: 3,
      ambienceId: 'recover_wake_dawn',
      when: { phases: ['dawn', 'morning'] },
    },
  ],
  tired: [
    { variantId: 'recover_tired_shake', weight: 3, ambienceId: 'recover_tired_shake' },
    {
      variantId: 'recover_tired_sun',
      weight: 3,
      ambienceId: 'recover_tired_sun',
      when: { weathers: ['clear'] },
    },
  ],
  needs_help: [
    { variantId: 'recover_help_relief', weight: 3, ambienceId: 'recover_help_relief' },
    {
      variantId: 'recover_help_together',
      weight: 3,
      ambienceId: 'recover_help_together',
      when: { visitorPresent: true },
    },
  ],
}

/** Staging for the five JST phases of the day (spec §5.3, §6.2). */
export const PHASE_AMBIENCE: Readonly<Record<WorldPhaseId, Identifier>> = {
  dawn: 'phase_dawn',
  morning: 'phase_morning',
  afternoon: 'phase_afternoon',
  evening: 'phase_evening',
  night: 'phase_night',
}
