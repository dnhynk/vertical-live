import type { IsoUtcInstant, TextKey, WorldSnapshot } from '@vl/contract'

import { dominantNeed, growthStageOf, lifeStageOf } from './creature.js'
import { toMillis } from './time.js'
import { CHAPTER_BEATS, type GameState, type WorldState } from './types.js'

/**
 * Read model projection: the world state narrowed to the contract fields the
 * renderer reads (spec §5.2, §6.3).
 *
 * The engine (T8) owns `stateRevision`, `processedIngestSeq`, `inputMode`,
 * `interactionEnabled`, `broadcastLifecycle` and `display.aggregateWindow`, so
 * they are not produced here — this returns exactly the world's share of the
 * snapshot and the engine merges it.
 *
 * Every string that reaches the screen is an identifier or a dotted i18n key, so
 * a chat line has no path onto the broadcast through the snapshot (spec §12.3),
 * and no field names a person (spec §7.4, BOARD A-1).
 */
export type WorldView = Pick<
  WorldSnapshot,
  'worldTimeUtc' | 'creature' | 'mission' | 'environment' | 'nextTransitionAt' | 'display'
>

/** The earliest pending deadline, i.e. the next state transition (spec §6.3). */
export function nextTransitionAt(world: GameState): IsoUtcInstant {
  let earliestAt: IsoUtcInstant | null = null
  for (const deadline of world.deadlines) {
    if (earliestAt === null || toMillis(deadline.dueAt) < toMillis(earliestAt)) {
      earliestAt = deadline.dueAt
    }
  }
  return earliestAt ?? world.worldTimeUtc
}

/**
 * When the room next gets a say. While the identity gate is closed this is the
 * director's preview rather than a call to vote (spec §6.4, BOARD A-9).
 */
export function nextChoiceAt(world: GameState): IsoUtcInstant | null {
  if (world.choice !== null) return world.choice.closesAt
  const turn = world.deadlines.find(
    (deadline) => deadline.kind === 'chapter_beat' && deadline.key === 'turn',
  )
  return turn?.dueAt ?? null
}

function needOrMissionKey(world: GameState): TextKey {
  if (world.creature.crisis !== null) return `crisis.${world.creature.crisis}`
  if (world.mission.progress.current > 0) return `mission.${world.mission.missionId}`
  return `need.${dominantNeed(world.creature.needs)}`
}

function needOrMissionIcon(world: GameState): string {
  if (world.creature.crisis !== null) return `icon_crisis_${world.creature.crisis}`
  return `icon_need_${dominantNeed(world.creature.needs)}`
}

export function projectWorldView(state: WorldState): WorldView {
  const world = state.world

  return {
    worldTimeUtc: world.worldTimeUtc,
    creature: {
      creatureId: world.creature.creatureId,
      lifeStage: lifeStageOf(world.creature.growthStageIndex),
      growthStage: growthStageOf(world.creature.growthStageIndex),
      needId: dominantNeed(world.creature.needs),
      emotionId: world.creature.emotionId,
      bondProgress: world.creature.bond,
      growthProgress: world.creature.growth,
    },
    mission: {
      missionId: world.mission.missionId,
      progress: world.mission.progress,
      // The contract carries the open decision on the active mission; when no
      // window is open the list is empty and the screen shows the preview only.
      choices:
        world.choice?.options.map((option) => ({
          choiceId: option.choiceId,
          labelKey: option.labelKey,
          commandName: option.commandName,
        })) ?? [],
      choiceClosesAt: world.choice?.closesAt ?? null,
    },
    environment: {
      environmentId: world.environment.environmentId,
      worldPhaseId: world.environment.worldPhaseId,
      weatherId: world.environment.weatherId,
      chapterId: world.chapter.chapterId,
      chapterProgress: {
        current: world.chapter.beatsPlayed.length,
        target: CHAPTER_BEATS.length,
      },
    },
    nextTransitionAt: nextTransitionAt(world),
    display: {
      currentNeedOrMission: {
        textKey: needOrMissionKey(world),
        iconId: needOrMissionIcon(world),
      },
      lastAppliedAction: world.lastAppliedAction,
      growthOrChapterProgress: {
        textKey: `chapter.${world.chapter.chapterId}`,
        progress: {
          current: Math.min(world.creature.growth.current, world.creature.growth.target),
          target: world.creature.growth.target,
        },
      },
      nextChoiceAt: nextChoiceAt(world),
    },
  }
}
