import type { IsoUtcInstant, Progress } from '@vl/contract'

import type { WorldTuning } from './content/tuning.js'
import { MILLIS_PER_HOUR, millisBetween } from './time.js'
import {
  GROWTH_STAGES,
  NEED_IDS,
  type CreatureDomainState,
  type CrisisId,
  type EmotionId,
  type GrowthStage,
  type LifeStage,
  type NeedId,
  type WorldPhaseId,
} from './types.js'

/**
 * Creature rules of spec §6.3.
 *
 * Two invariants are load-bearing and are asserted by `creature.test.ts`:
 * 1. the creature never dies and never regresses — growth is monotonic and need
 *    pressure is clamped to [0, 1], so no amount of neglect can remove a stage;
 * 2. every crisis is recoverable by elapsed time and free actions alone, which
 *    is why `applySelfCare` exists at all: with zero viewers the world still
 *    walks the creature back out of `sleeping` / `tired` / `needs_help`.
 */

const MIN_PRESSURE = 0
const MAX_PRESSURE = 1

export function clampPressure(value: number): number {
  if (!Number.isFinite(value)) return MIN_PRESSURE
  return Math.min(MAX_PRESSURE, Math.max(MIN_PRESSURE, value))
}

export function mapNeeds(
  needs: Readonly<Record<NeedId, number>>,
  fn: (need: NeedId, value: number) => number,
): Record<NeedId, number> {
  const next = {} as Record<NeedId, number>
  for (const need of NEED_IDS) next[need] = clampPressure(fn(need, needs[need]))
  return next
}

/** The need under the most pressure; ties resolve in `NEED_IDS` order. */
export function dominantNeed(needs: Readonly<Record<NeedId, number>>): NeedId {
  let winner: NeedId = NEED_IDS[0]
  for (const need of NEED_IDS) {
    if (needs[need] > needs[winner]) winner = need
  }
  return winner
}

/**
 * Integrates need pressure over the time since it was last integrated.
 *
 * Two things happen here, both as rates rather than as per-tick steps: pressure
 * rises with time, and while the creature is in a crisis the world cares for it
 * by itself (spec §6.3 — crises recover through elapsed time and free group
 * action; with zero viewers the elapsed-time half has to be enough, or spec §2.1
 * "입력이 없어도 방송이어야 한다" would produce a permanently distressed creature).
 *
 * Because the result is a function of elapsed absolute time rather than of the
 * number of ticks, one delivery after downtime reproduces the whole gap — which
 * is what the `coalesce` policy of `need_decay` and `crisis_recovery` relies on
 * (spec §10.2).
 */
export function integrateNeeds(
  creature: CreatureDomainState,
  now: IsoUtcInstant,
  tuning: WorldTuning,
): CreatureDomainState {
  const elapsedHours = Math.max(0, millisBetween(now, creature.needsUpdatedAt)) / MILLIS_PER_HOUR
  if (elapsedHours === 0) return creature
  const asleep = creature.crisis === 'sleeping'
  const inCrisis = creature.crisis !== null
  const needs = mapNeeds(creature.needs, (need, value) => {
    const rate = tuning.needs.rates[need]
    const base = asleep ? rate.asleepPerHour : rate.awakePerHour
    const selfCare =
      inCrisis && value >= tuning.crisis.exitThreshold ? tuning.crisis.selfCarePerHour : 0
    return value + (base - selfCare) * elapsedHours
  })
  return { ...creature, needs, needsUpdatedAt: now }
}

/**
 * Which recoverable crisis the creature is in, with hysteresis so it does not
 * flap across the entry threshold. Returning `null` is "fine"; there is no state
 * below `needs_help`, because spec §6.3 forbids death and permanent regression.
 */
export function evaluateCrisis(
  needs: Readonly<Record<NeedId, number>>,
  phase: WorldPhaseId,
  current: CrisisId | null,
  tuning: WorldTuning,
): CrisisId | null {
  const { enterThreshold, exitThreshold, needsHelpThreshold, sleepThreshold, wakeThreshold } =
    tuning.crisis
  const nightly = phase === 'night' || phase === 'dawn'
  if (nightly) {
    if (needs.rest >= sleepThreshold) return 'sleeping'
    if (current === 'sleeping' && needs.rest > wakeThreshold) return 'sleeping'
  }

  const overEnter = NEED_IDS.filter((need) => needs[need] >= enterThreshold)
  const overHelp = NEED_IDS.filter((need) => needs[need] >= needsHelpThreshold)
  const overExit = NEED_IDS.filter((need) => needs[need] >= exitThreshold)

  if (overHelp.length >= 2) return 'needs_help'
  if (current === 'needs_help' && overExit.length >= 2) return 'needs_help'
  if (overEnter.length >= 1) return 'tired'
  if ((current === 'tired' || current === 'needs_help') && overExit.length >= 1) return 'tired'
  return null
}

export function deriveEmotion(
  needs: Readonly<Record<NeedId, number>>,
  crisis: CrisisId | null,
): EmotionId {
  if (crisis === 'sleeping') return 'sleepy'
  if (crisis === 'tired') return 'weary'
  if (crisis === 'needs_help') return 'worried'
  const need = dominantNeed(needs)
  if (needs[need] < 0.3) return 'joyful'
  if (need === 'affection') return 'lonely'
  if (need === 'play') return 'curious'
  return 'content'
}

export function growthStageOf(index: number): GrowthStage {
  const clamped = Math.min(GROWTH_STAGES.length - 1, Math.max(0, index))
  return GROWTH_STAGES[clamped] ?? GROWTH_STAGES[0]
}

/** Coarse life stage shown on screen, derived from the growth ladder. */
export function lifeStageOf(index: number): LifeStage {
  if (index <= 0) return 'egg'
  if (index === 1) return 'child'
  if (index === 2) return 'youth'
  return 'adult'
}

export function growthTargetFor(index: number, tuning: WorldTuning): number {
  const targets = tuning.growth.stageTargets
  return targets[Math.min(index, targets.length - 1)] ?? 1
}

function addProgress(progress: Progress, amount: number): Progress {
  return { ...progress, current: Math.max(0, Math.min(progress.target, progress.current + amount)) }
}

export function addBond(creature: CreatureDomainState, amount: number): CreatureDomainState {
  if (amount <= 0) return creature
  return { ...creature, bond: addProgress(creature.bond, amount) }
}

export interface GrowthResult {
  readonly creature: CreatureDomainState
  /** The stage left behind, when the creature advanced. */
  readonly advancedFrom: GrowthStage | null
}

/**
 * Adds growth and advances the stage when the target is met. Growth only ever
 * moves forward: a negative amount is ignored and the stage index never drops
 * (spec §6.3 "죽거나 영구 퇴화하지 않는다"). Only free participation and elapsed
 * time call this — the paid path has no access to a `GameState` at all (§8.5).
 */
export function addGrowth(
  creature: CreatureDomainState,
  amount: number,
  tuning: WorldTuning,
): GrowthResult {
  if (amount <= 0) return { creature, advancedFrom: null }
  const isFinalStage = creature.growthStageIndex >= GROWTH_STAGES.length - 1
  const raised = creature.growth.current + amount
  if (isFinalStage || raised < creature.growth.target) {
    return {
      creature: { ...creature, growth: addProgress(creature.growth, amount) },
      advancedFrom: null,
    }
  }
  const nextIndex = creature.growthStageIndex + 1
  return {
    creature: {
      ...creature,
      growthStageIndex: nextIndex,
      growth: {
        current: Math.min(raised - creature.growth.target, growthTargetFor(nextIndex, tuning)),
        target: growthTargetFor(nextIndex, tuning),
      },
    },
    advancedFrom: growthStageOf(creature.growthStageIndex),
  }
}
