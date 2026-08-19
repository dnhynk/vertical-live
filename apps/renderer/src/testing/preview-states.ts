import {
  CONTRACT_VERSION,
  EffectSchema,
  WorldSnapshotSchema,
  type Effect,
  type WorldSnapshot,
} from '@vl/contract'

/**
 * The six representative screens of TASK_SPECS §T14 acceptance 1, plus the
 * consented-viewer screen of §T20c, as contract values the preview harness can
 * send over a real WebSocket.
 *
 * Two kinds of identifier meet here and they are treated differently:
 *
 * - **content vocabulary** (`need.hungry`, `home_room`, `gathering`, …) is the
 *   content director's, defined in T7 (`apps/server/src/world/types.ts`,
 *   `content/chapters.ts`). It is used verbatim, because the point of these
 *   states is to show what the real world will look like — the wording, the
 *   icons and the palette all key off exactly these values;
 * - **anything that stands for participation** — broadcast, message and event
 *   keys — is plainly synthetic (`simulator:` source, `sample-` ids). Nothing
 *   here may look like a real viewer, a real message or a real payment
 *   (spec §2.6, CLAUDE.md §3). The one screen that carries a name carries
 *   `SAMPLE_CONSENTED_ACTOR`, which says what it is and holds an opaque
 *   `channelRef` rather than anything a channel id could be mistaken for
 *   (BOARD D-9, T20a).
 *
 * This module is test/preview scaffolding: `no-fabrication.test.ts` checks that
 * no application module imports it, so it cannot reach the broadcast bundle.
 */

const T0 = Date.parse('2026-08-17T12:00:00.000Z')

function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString()
}

/** Every event key here names the simulator, never a broadcast (spec §2.6). */
const SAMPLE_EVENT_KEY = 'simulator:sample-broadcast:sample-message-1'

/**
 * The one consented viewer any preview shows (BOARD D-9). Declared here rather
 * than imported from `fixtures.ts` for the same reason `SAMPLE_EVENT_KEY` is:
 * `scripts/capture.mjs` loads this module directly with Node's type stripper,
 * which resolves no extensionless relative import.
 *
 * Both values are plainly synthetic. `channelRef` is the opaque reference the
 * contract issues instead of a channel id, so no preview and no screenshot can
 * carry one (spec §2.6, §12.4; T20a).
 */
const SAMPLE_CONSENTED_ACTOR = {
  kind: 'consented',
  displayName: 'sample-viewer-1',
  channelRef: 'ref_0123456789abcdef0123456789abcdef',
} as const

interface SnapshotDraft {
  readonly stateRevision: number
  readonly inputMode: WorldSnapshot['inputMode']
  readonly interactionEnabled: boolean
  readonly broadcastLifecycle: WorldSnapshot['broadcastLifecycle']
  readonly creature: WorldSnapshot['creature']
  readonly mission: WorldSnapshot['mission']
  readonly environment: WorldSnapshot['environment']
  readonly display: WorldSnapshot['display']
}

function snapshotOf(draft: SnapshotDraft): WorldSnapshot {
  return WorldSnapshotSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    processedIngestSeq: draft.stateRevision * 7,
    worldTimeUtc: at(0),
    nextTransitionAt: at(240_000),
    ...draft,
  })
}

export interface PreviewState {
  readonly name: string
  /** What the screenshot is meant to show, for the ticket. */
  readonly description: string
  readonly snapshot: WorldSnapshot
  readonly effects: readonly Effect[]
}

function ambience(effectId: string, ambienceId: string, deadlineKind: string): Effect {
  return EffectSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    effectId,
    cause: { kind: 'deadline', deadlineKind },
    causedByEventKey: null,
    stateRevision: 1,
    startsAt: at(-2_000),
    endsAt: at(600_000),
    paid: false,
    kind: 'AMBIENCE',
    payload: { ambienceId },
  })
}

const CALM: PreviewState = {
  name: 'calm',
  description: 'Normal afternoon: a mission in progress, direct input, nothing playing.',
  snapshot: snapshotOf({
    stateRevision: 41,
    inputMode: 'direct',
    interactionEnabled: true,
    broadcastLifecycle: 'live',
    creature: {
      creatureId: 'sample-creature-1',
      lifeStage: 'youth',
      growthStage: 'fledgling',
      needId: 'affection',
      emotionId: 'content',
      bondProgress: { current: 6, target: 12 },
      growthProgress: { current: 5, target: 12 },
    },
    mission: {
      missionId: 'gather_ingredients',
      progress: { current: 2, target: 5 },
      choices: [],
      choiceClosesAt: null,
    },
    environment: {
      environmentId: 'garden',
      worldPhaseId: 'afternoon',
      weatherId: 'clear',
      chapterId: 'gathering',
      chapterProgress: { current: 1, target: 3 },
    },
    display: {
      currentNeedOrMission: {
        textKey: 'mission.gather_ingredients',
        iconId: 'icon_need_affection',
      },
      lastAppliedAction: { commandName: 'PET', appliedAt: at(-45_000), contributionCount: 4 },
      growthOrChapterProgress: {
        textKey: 'chapter.gathering',
        progress: { current: 5, target: 12 },
      },
      nextChoiceAt: at(900_000),
    },
  }),
  effects: [ambience('sample-effect-calm-1', 'idle_garden_sniff', 'idle_beat')],
}

const HUNGRY: PreviewState = {
  name: 'hungry',
  description: 'The creature is hungry and the room has just fed it.',
  snapshot: snapshotOf({
    stateRevision: 52,
    inputMode: 'direct',
    interactionEnabled: true,
    broadcastLifecycle: 'live',
    creature: {
      creatureId: 'sample-creature-1',
      lifeStage: 'youth',
      growthStage: 'fledgling',
      needId: 'hungry',
      emotionId: 'curious',
      bondProgress: { current: 7, target: 12 },
      growthProgress: { current: 6, target: 12 },
    },
    mission: {
      missionId: 'share_a_meal',
      progress: { current: 0, target: 4 },
      choices: [],
      choiceClosesAt: null,
    },
    environment: {
      environmentId: 'home_room',
      worldPhaseId: 'morning',
      weatherId: 'cloudy',
      chapterId: 'gathering',
      chapterProgress: { current: 1, target: 3 },
    },
    display: {
      currentNeedOrMission: { textKey: 'need.hungry', iconId: 'icon_need_hungry' },
      lastAppliedAction: { commandName: 'FEED', appliedAt: at(-8_000), contributionCount: 11 },
      growthOrChapterProgress: {
        textKey: 'chapter.gathering',
        progress: { current: 6, target: 12 },
      },
      nextChoiceAt: at(420_000),
    },
  }),
  effects: [
    EffectSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      effectId: 'sample-effect-feed-1',
      cause: { kind: 'event', eventKey: SAMPLE_EVENT_KEY },
      causedByEventKey: SAMPLE_EVENT_KEY,
      stateRevision: 52,
      startsAt: at(-2_000),
      endsAt: at(600_000),
      paid: false,
      kind: 'ACTION_REACTION',
      payload: { commandName: 'FEED', contributionCount: 11 },
    }),
    ambience('sample-effect-feed-2', 'feed_polite_nibble', 'idle_beat'),
  ],
}

const PLAY: PreviewState = {
  name: 'play',
  description: 'Play mission at the riverside with an open aggregate window and its tally.',
  snapshot: snapshotOf({
    stateRevision: 88,
    inputMode: 'aggregate',
    interactionEnabled: true,
    broadcastLifecycle: 'live',
    creature: {
      creatureId: 'sample-creature-1',
      lifeStage: 'youth',
      growthStage: 'companion',
      needId: 'play',
      emotionId: 'joyful',
      bondProgress: { current: 9, target: 12 },
      growthProgress: { current: 9, target: 12 },
    },
    mission: {
      missionId: 'chase_the_ribbon',
      progress: { current: 3, target: 5 },
      choices: [
        { choiceId: 'river_walk', labelKey: 'choice.gathering.river_walk', commandName: null },
        {
          choiceId: 'forage_garden',
          labelKey: 'choice.gathering.forage_garden',
          commandName: null,
        },
        { choiceId: 'rest_indoors', labelKey: 'choice.gathering.rest_indoors', commandName: null },
      ],
      choiceClosesAt: at(120_000),
    },
    environment: {
      environmentId: 'riverside',
      worldPhaseId: 'afternoon',
      weatherId: 'wind',
      chapterId: 'gathering',
      chapterProgress: { current: 2, target: 3 },
    },
    display: {
      currentNeedOrMission: { textKey: 'mission.chase_the_ribbon', iconId: 'icon_need_play' },
      lastAppliedAction: { commandName: 'PLAY', appliedAt: at(-3_000), contributionCount: 37 },
      growthOrChapterProgress: {
        textKey: 'chapter.gathering',
        progress: { current: 9, target: 12 },
      },
      nextChoiceAt: at(120_000),
      aggregateWindow: {
        mode: 'aggregate',
        endsAt: at(18_000),
        tallies: [
          { commandName: 'PLAY', count: 37 },
          { commandName: 'FEED', count: 14 },
          { commandName: 'PET', count: 9 },
        ],
      },
    },
  }),
  effects: [
    EffectSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      effectId: 'sample-effect-play-1',
      cause: { kind: 'event', eventKey: SAMPLE_EVENT_KEY },
      causedByEventKey: SAMPLE_EVENT_KEY,
      stateRevision: 88,
      startsAt: at(-1_000),
      endsAt: at(600_000),
      paid: false,
      kind: 'ACTION_REACTION',
      payload: { commandName: 'PLAY', contributionCount: 37 },
    }),
    EffectSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      effectId: 'sample-effect-play-2',
      cause: { kind: 'deadline', deadlineKind: 'mission_close' },
      causedByEventKey: null,
      stateRevision: 88,
      startsAt: at(-1_000),
      endsAt: at(600_000),
      paid: false,
      kind: 'MISSION_UPDATE',
      payload: { missionId: 'chase_the_ribbon', phase: 'PROGRESS' },
    }),
  ],
}

const SLEEPING: PreviewState = {
  name: 'sleeping',
  description: 'Night rest: a recoverable crisis, quiet light, input still open.',
  snapshot: snapshotOf({
    stateRevision: 120,
    inputMode: 'direct',
    interactionEnabled: true,
    broadcastLifecycle: 'live',
    creature: {
      creatureId: 'sample-creature-1',
      lifeStage: 'youth',
      growthStage: 'companion',
      needId: 'rest',
      emotionId: 'sleepy',
      bondProgress: { current: 10, target: 12 },
      growthProgress: { current: 10, target: 12 },
    },
    mission: {
      missionId: 'quiet_company',
      progress: { current: 1, target: 3 },
      choices: [],
      choiceClosesAt: null,
    },
    environment: {
      environmentId: 'night_terrace',
      worldPhaseId: 'night',
      weatherId: 'starry',
      chapterId: 'festival_prep',
      chapterProgress: { current: 3, target: 3 },
    },
    display: {
      currentNeedOrMission: { textKey: 'crisis.sleeping', iconId: 'icon_crisis_sleeping' },
      lastAppliedAction: { commandName: 'PET', appliedAt: at(-600_000), contributionCount: 6 },
      growthOrChapterProgress: {
        textKey: 'chapter.festival_prep',
        progress: { current: 10, target: 12 },
      },
      nextChoiceAt: null,
    },
  }),
  effects: [ambience('sample-effect-sleep-1', 'idle_curl_sleep', 'idle_beat')],
}

const DEGRADED: PreviewState = {
  name: 'degraded',
  description: 'Degraded: the CTA is withdrawn and the screen says input is paused (spec §9.2).',
  snapshot: snapshotOf({
    stateRevision: 131,
    inputMode: 'direct',
    interactionEnabled: false,
    broadcastLifecycle: 'degraded',
    creature: {
      creatureId: 'sample-creature-1',
      lifeStage: 'youth',
      growthStage: 'companion',
      needId: 'rest',
      emotionId: 'weary',
      bondProgress: { current: 10, target: 12 },
      growthProgress: { current: 10, target: 12 },
    },
    mission: {
      missionId: 'quiet_company',
      progress: { current: 1, target: 3 },
      choices: [],
      choiceClosesAt: null,
    },
    environment: {
      environmentId: 'home_room',
      worldPhaseId: 'evening',
      weatherId: 'rain',
      chapterId: 'festival_prep',
      chapterProgress: { current: 2, target: 3 },
    },
    display: {
      currentNeedOrMission: { textKey: 'crisis.tired', iconId: 'icon_crisis_tired' },
      lastAppliedAction: { commandName: 'PET', appliedAt: at(-300_000), contributionCount: 3 },
      growthOrChapterProgress: {
        textKey: 'chapter.festival_prep',
        progress: { current: 10, target: 12 },
      },
      nextChoiceAt: at(1_800_000),
    },
  }),
  effects: [ambience('sample-effect-degraded-1', 'idle_slow_breath', 'idle_beat')],
}

const PAID_THANKS: PreviewState = {
  name: 'paid-thanks',
  description: 'Paid acknowledgement: fixed staging, anonymous icon, free-participation note.',
  snapshot: snapshotOf({
    stateRevision: 96,
    inputMode: 'direct',
    interactionEnabled: true,
    broadcastLifecycle: 'live',
    creature: {
      creatureId: 'sample-creature-1',
      lifeStage: 'youth',
      growthStage: 'companion',
      needId: 'affection',
      emotionId: 'joyful',
      bondProgress: { current: 8, target: 12 },
      growthProgress: { current: 8, target: 12 },
    },
    mission: {
      missionId: 'hang_the_lanterns',
      progress: { current: 2, target: 4 },
      choices: [],
      choiceClosesAt: null,
    },
    environment: {
      environmentId: 'night_terrace',
      worldPhaseId: 'evening',
      weatherId: 'clear',
      chapterId: 'festival_prep',
      chapterProgress: { current: 2, target: 3 },
    },
    display: {
      currentNeedOrMission: { textKey: 'mission.hang_the_lanterns', iconId: 'icon_need_affection' },
      lastAppliedAction: { commandName: 'PLAY', appliedAt: at(-20_000), contributionCount: 18 },
      growthOrChapterProgress: {
        textKey: 'chapter.festival_prep',
        progress: { current: 8, target: 12 },
      },
      nextChoiceAt: at(300_000),
    },
  }),
  effects: [
    EffectSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      effectId: 'sample-effect-thanks-1',
      cause: { kind: 'event', eventKey: SAMPLE_EVENT_KEY },
      causedByEventKey: SAMPLE_EVENT_KEY,
      stateRevision: 96,
      startsAt: at(-1_000),
      endsAt: at(600_000),
      paid: true,
      kind: 'PAID_THANKS',
      payload: {
        paidEventKind: 'SUPER_CHAT',
        iconId: 'thanks_super_chat',
        tier: 2,
        fallback: false,
      },
    }),
    ambience('sample-effect-thanks-2', 'chapter_festival_turn', 'chapter_beat'),
  ],
}

const CONSENTED_ACTION: PreviewState = {
  name: 'consented-action',
  description:
    'A viewer who opted in is named beside their own action; the CTA carries the consent notice.',
  snapshot: snapshotOf({
    stateRevision: 64,
    inputMode: 'direct',
    interactionEnabled: true,
    broadcastLifecycle: 'live',
    creature: {
      creatureId: 'sample-creature-1',
      lifeStage: 'youth',
      growthStage: 'fledgling',
      needId: 'affection',
      emotionId: 'joyful',
      bondProgress: { current: 8, target: 12 },
      growthProgress: { current: 7, target: 12 },
    },
    mission: {
      missionId: 'quiet_company',
      progress: { current: 1, target: 3 },
      choices: [],
      choiceClosesAt: null,
    },
    environment: {
      environmentId: 'home_room',
      worldPhaseId: 'evening',
      weatherId: 'clear',
      chapterId: 'gathering',
      chapterProgress: { current: 2, target: 3 },
    },
    display: {
      currentNeedOrMission: { textKey: 'need.affection', iconId: 'icon_need_affection' },
      // One viewer, one command: the count is 1 because a name may only ride on
      // an action that is one person's (spec §6.4, §7.3, BOARD D-9). The instant
      // is `at(0)` — the world time itself — because `preview-server.mjs` shifts
      // the snapshot onto the current clock while starting every effect one
      // second before it, and the slot only names an action its reaction did not
      // start *after* (`read-model/identity.ts`).
      lastAppliedAction: { commandName: 'PET', appliedAt: at(0), contributionCount: 1 },
      growthOrChapterProgress: {
        textKey: 'chapter.gathering',
        progress: { current: 7, target: 12 },
      },
      nextChoiceAt: at(600_000),
    },
  }),
  effects: [
    EffectSchema.parse({
      schemaVersion: CONTRACT_VERSION,
      effectId: 'sample-effect-consented-1',
      cause: { kind: 'event', eventKey: SAMPLE_EVENT_KEY },
      causedByEventKey: SAMPLE_EVENT_KEY,
      stateRevision: 64,
      // Staged by the same commit that set `lastAppliedAction` above, which is
      // what lets the slot join the two and show the name (T20c).
      startsAt: at(-2_000),
      endsAt: at(600_000),
      paid: false,
      kind: 'ACTION_REACTION',
      actor: SAMPLE_CONSENTED_ACTOR,
      payload: { commandName: 'PET', contributionCount: 1 },
    }),
    ambience('sample-effect-consented-2', 'pet_soft_lean', 'idle_beat'),
  ],
}

export const PREVIEW_STATES: readonly PreviewState[] = [
  CALM,
  HUNGRY,
  PLAY,
  SLEEPING,
  DEGRADED,
  PAID_THANKS,
  CONSENTED_ACTION,
]

export function previewState(name: string): PreviewState | undefined {
  return PREVIEW_STATES.find((state) => state.name === name)
}
