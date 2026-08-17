import type { Identifier } from '@vl/contract'

import { FRESHNESS_MINIMUMS, type WorldTuning } from './content/tuning.js'
import { matchesCondition, type ContentContext, type Variant } from './content/variants.js'
import type { Rng } from './rng.js'
import {
  TIME_SCALES,
  TRANSITION_SCALES,
  type TimeScale,
  type VariationState,
  type WorldTransition,
} from './types.js'

/**
 * Repeat avoidance (spec §12.5) and the two "신선도" metrics of spec §14.1.
 *
 * Selection is three steps: keep the variants whose condition the current world
 * satisfies, drop the ones used most recently, then draw from what is left with
 * the seeded RNG. Step 1 is what makes the same command produce different
 * staging in different states; step 2 is what stops a long stretch of identical
 * scenes even when the state does not change.
 */

export function selectVariant<T extends Variant>(
  candidates: readonly T[],
  context: ContentContext,
  variation: VariationState,
  rng: Rng,
): T | null {
  const eligible = candidates.filter((candidate) => matchesCondition(candidate.when, context))
  if (eligible.length === 0) return null

  const fresh = eligible.filter(
    (candidate) => !variation.recentVariantIds.includes(candidate.variantId),
  )
  // Falling back to the eligible set matters: with a small catalogue for a rare
  // context, "never repeat" would otherwise mean "stage nothing".
  const pool = fresh.length > 0 ? fresh : eligible
  return rng.pickWeighted(pool, (candidate) => candidate.weight)
}

/** The scene a variant stages, as observed by a viewer (spec §12.5). */
export function sceneKeyFor(variantId: Identifier, context: ContentContext): string {
  return `${variantId}@${context.environment}/${context.weather}/${context.phase}`
}

/** Records a used variant and scene in the bounded rings. */
export function rememberVariant(
  variation: VariationState,
  variantId: Identifier | null,
  sceneKey: string | null,
  tuning: WorldTuning,
): VariationState {
  const recentVariantIds =
    variantId === null
      ? variation.recentVariantIds
      : [...variation.recentVariantIds, variantId].slice(-tuning.variation.recentVariantWindow)
  const recentSceneKeys =
    sceneKey === null
      ? variation.recentSceneKeys
      : [...variation.recentSceneKeys, sceneKey].slice(-tuning.variation.recentSceneWindow)
  return { recentVariantIds, recentSceneKeys }
}

/**
 * Identity of a state transition for the §14.1 "고유 상태 전이" count: the kind of
 * change, the variant that staged it and the endpoints. Two transitions that
 * differ only in their timestamp are the same transition.
 */
export function transitionSignature(transition: WorldTransition): string {
  return [
    transition.type,
    transition.variantId ?? '-',
    transition.from ?? '-',
    transition.to,
    transition.cause,
  ].join('|')
}

export function countUniqueTransitions(transitions: readonly WorldTransition[]): number {
  return new Set(transitions.map(transitionSignature)).size
}

/**
 * Share of a recent scene sample that repeats an earlier scene in the same
 * sample (spec §14.1 "반복 장면 표본 비율"). 0 means every sampled scene was
 * distinct; transitions that staged no scene are not sampled.
 *
 * `scales` restricts the sample to some of the §6.2 time scales. It matters
 * because a 24-hour ambient loop stages thousands of seconds-scale idle beats
 * from a small catalogue, so an unrestricted sample measures mostly breathing.
 * Spec §12.5 is about *scenes* repeating, so the report below carries the
 * narrative sample (minutes and slower) next to the unrestricted one instead of
 * quietly picking one of them.
 */
export function repeatedSceneRatio(
  transitions: readonly WorldTransition[],
  sampleSize: number = FRESHNESS_MINIMUMS.sceneSampleSize,
  scales: readonly TimeScale[] = TIME_SCALES,
): number {
  const scenes = transitions
    .filter((transition) => scales.includes(TRANSITION_SCALES[transition.type]))
    .map((transition) => transition.sceneKey)
    .filter((sceneKey): sceneKey is string => sceneKey !== null)
    .slice(-Math.max(1, Math.floor(sampleSize)))
  if (scenes.length === 0) return 0
  return (scenes.length - new Set(scenes).size) / scenes.length
}

/** Everything slower than the seconds scale, i.e. what reads as a scene. */
export const NARRATIVE_SCALES: readonly TimeScale[] = ['minutes', 'hours', 'day']

export interface FreshnessReport {
  readonly totalTransitions: number
  readonly uniqueTransitions: number
  readonly sceneSampleSize: number
  /** Over every staged scene, seconds-scale idle staging included. */
  readonly repeatedSceneRatio: number
  /** Over minutes-and-slower staging only (spec §12.5 "장면"). */
  readonly repeatedNarrativeSceneRatio: number
  /** How many transitions each §6.2 time scale produced. */
  readonly transitionsByScale: Readonly<Record<TimeScale, number>>
}

export function computeFreshness(
  transitions: readonly WorldTransition[],
  sampleSize: number = FRESHNESS_MINIMUMS.sceneSampleSize,
): FreshnessReport {
  const transitionsByScale = {} as Record<TimeScale, number>
  for (const scale of TIME_SCALES) transitionsByScale[scale] = 0
  for (const transition of transitions) {
    const scale = TRANSITION_SCALES[transition.type]
    transitionsByScale[scale] += 1
  }
  return {
    totalTransitions: transitions.length,
    uniqueTransitions: countUniqueTransitions(transitions),
    sceneSampleSize: sampleSize,
    repeatedSceneRatio: repeatedSceneRatio(transitions, sampleSize),
    repeatedNarrativeSceneRatio: repeatedSceneRatio(transitions, sampleSize, NARRATIVE_SCALES),
    transitionsByScale,
  }
}

/**
 * Checks a report against the provisional floors of `FRESHNESS_MINIMUMS`. The
 * floors are regression guards, not approved pass lines (BOARD A-15).
 */
export function meetsFreshnessMinimums(
  report: FreshnessReport,
  minimums = FRESHNESS_MINIMUMS,
): boolean {
  return (
    report.uniqueTransitions >= minimums.uniqueTransitionsPerVirtualDay &&
    report.repeatedNarrativeSceneRatio <= minimums.maxRepeatedNarrativeSceneRatio
  )
}
