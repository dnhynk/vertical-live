import type { CareCommand, NeedId } from '../types.js'

/**
 * Numeric content tuning.
 *
 * None of these are spec constants: spec §6.2/§6.3 fix the *shape* of the
 * content (four time scales, recoverable crises, free-only growth) and leave the
 * pacing to the content director. They are therefore marked `provisional`
 * (BOARD A-15) and `step()` accepts an override, so T8 can feed values from
 * `config/*` once that file lands without touching this module.
 *
 * Rates are per hour of world time so that every derived value is a function of
 * elapsed absolute time — that is what lets the `coalesce` deadline policy of
 * spec §10.2 reproduce a downtime exactly (see `deadlines.ts`).
 */

export interface NeedRates {
  readonly awakePerHour: number
  readonly asleepPerHour: number
}

export interface WorldTuning {
  /** Always true: these values are not approved pass lines (BOARD A-15). */
  readonly provisional: true

  readonly idleBeat: {
    readonly minIntervalMs: number
    readonly maxIntervalMs: number
    readonly durationMs: number
  }

  readonly needs: {
    readonly decayIntervalMs: number
    readonly rates: Readonly<Record<NeedId, NeedRates>>
    /** Pressure removed by one accepted free command. */
    readonly relief: Readonly<Record<CareCommand, number>>
    /** Extra relief per additional contribution in one aggregated event. */
    readonly reliefPerExtraContribution: number
  }

  readonly crisis: {
    /** Pressure at which a single need pushes the creature into `tired`. */
    readonly enterThreshold: number
    /** Pressure the driving need must fall back under to leave the crisis. */
    readonly exitThreshold: number
    /** Two or more needs at this pressure escalate to `needs_help`. */
    readonly needsHelpThreshold: number
    /** Rest pressure at night that puts the creature to sleep. */
    readonly sleepThreshold: number
    /** Rest pressure the creature wakes up at. */
    readonly wakeThreshold: number
    readonly recoveryIntervalMs: number
    /** Pressure the world removes by itself while recovering (spec §6.3). */
    readonly selfCarePerHour: number
  }

  /** How long one staged effect occupies the screen. */
  readonly staging: {
    readonly ambienceMs: number
    readonly reactionMs: number
    readonly missionMs: number
  }

  readonly mission: {
    readonly durationMs: number
    readonly targetContributions: number
    readonly bondPerContribution: number
    readonly growthPerContribution: number
    /** Growth granted when the room completed the mission target. */
    readonly growthOnCompleted: number
    /** Growth granted when the mission simply ran out of time (no penalty). */
    readonly growthOnEased: number
    readonly bondOnCompleted: number
  }

  readonly choice: {
    readonly windowMs: number
    /** How long before it opens the screen previews "next choice" (spec §5.2). */
    readonly previewLeadMs: number
  }

  readonly chapter: {
    /** JST hour a chapter starts on (spec §5.3 time base). */
    readonly anchorHourJst: number
    /** The first chapter after a cold start is at least this long. */
    readonly minFirstDurationMs: number
    readonly turnFraction: number
    readonly resolutionFraction: number
    readonly growthOnResolution: number
    readonly bondOnResolution: number
  }

  readonly weather: { readonly intervalMs: number }

  readonly visitor: { readonly intervalMs: number; readonly stayMs: number }

  readonly paid: {
    readonly thanksDurationMs: number
    /**
     * How long the original thanks staging stays valid. Past it, the paid event
     * is owed exactly one substitute acknowledgement (spec §9.2).
     */
    readonly originalStagingWindowMs: number
    readonly fallbackDurationMs: number
    /** Size of the ring that guarantees one acknowledgement per event key. */
    readonly acknowledgedRingSize: number
  }

  readonly variation: {
    /** Variants used this recently are skipped when alternatives exist (§12.5). */
    readonly recentVariantWindow: number
    readonly recentSceneWindow: number
  }

  readonly growth: {
    /** Growth needed to leave each stage; the last stage has no target. */
    readonly stageTargets: readonly number[]
    readonly bondTarget: number
  }
}

export const DEFAULT_WORLD_TUNING: WorldTuning = {
  provisional: true,

  idleBeat: { minIntervalMs: 30_000, maxIntervalMs: 75_000, durationMs: 4_000 },

  needs: {
    decayIntervalMs: 90_000,
    rates: {
      hungry: { awakePerHour: 0.25, asleepPerHour: 0.06 },
      play: { awakePerHour: 0.2, asleepPerHour: 0 },
      affection: { awakePerHour: 0.15, asleepPerHour: 0.03 },
      rest: { awakePerHour: 0.1, asleepPerHour: -0.45 },
    },
    relief: { FEED: 0.34, PLAY: 0.3, PET: 0.26 },
    reliefPerExtraContribution: 0.04,
  },

  crisis: {
    enterThreshold: 0.8,
    exitThreshold: 0.6,
    needsHelpThreshold: 0.8,
    sleepThreshold: 0.5,
    wakeThreshold: 0.2,
    recoveryIntervalMs: 300_000,
    selfCarePerHour: 0.5,
  },

  staging: { ambienceMs: 6_000, reactionMs: 4_000, missionMs: 5_000 },

  mission: {
    durationMs: 20 * 60_000,
    targetContributions: 6,
    bondPerContribution: 1.5,
    growthPerContribution: 0.5,
    growthOnCompleted: 8,
    growthOnEased: 2,
    bondOnCompleted: 6,
  },

  choice: { windowMs: 20 * 60_000, previewLeadMs: 30 * 60_000 },

  chapter: {
    anchorHourJst: 6,
    minFirstDurationMs: 8 * 60 * 60_000,
    turnFraction: 0.35,
    resolutionFraction: 0.72,
    growthOnResolution: 30,
    bondOnResolution: 12,
  },

  weather: { intervalMs: 150 * 60_000 },

  visitor: { intervalMs: 210 * 60_000, stayMs: 40 * 60_000 },

  paid: {
    thanksDurationMs: 8_000,
    originalStagingWindowMs: 3 * 60_000,
    fallbackDurationMs: 6_000,
    acknowledgedRingSize: 256,
  },

  variation: { recentVariantWindow: 12, recentSceneWindow: 24 },

  growth: { stageTargets: [100, 160, 240, 340], bondTarget: 500 },
}

/**
 * Provisional floors for the spec §14.1 "신선도" axis, measured over one virtual
 * day with **no viewer input at all**. Spec §14.1 names the metrics but fixes no
 * pass line, and TASK_SPECS §T7 says the minimum is provisional (BOARD A-15):
 * these are regression floors set below what the current catalogue produces, to
 * be replaced by the Gate 0/2 approved values.
 */
export const FRESHNESS_MINIMUMS = {
  provisional: true,
  uniqueTransitionsPerVirtualDay: 40,
  maxRepeatedNarrativeSceneRatio: 0.7,
  sceneSampleSize: 200,
} as const
