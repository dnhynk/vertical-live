import { describe, expect, it } from 'vitest'

import {
  ActionReactionEffectSchema,
  EffectSchema,
  PaidThanksEffectSchema,
  type Effect,
} from './effect.js'
import { BroadcastLifecycleSchema, DeadlinePolicySchema, InputModeSchema } from './enums.js'
import { WorldSnapshotSchema, type WorldSnapshot } from './snapshot.js'
import { CONTRACT_VERSION } from './version.js'
import { RendererToServerMessageSchema, ServerToRendererMessageSchema } from './ws.js'

/**
 * The renderer-facing half of the contract: `WorldSnapshot` (spec §5.2, §6.3,
 * §6.4, §9.2), `Effect` (spec §7.3(6), §8.4) and the `/ws/renderer` protocol
 * (spec §7.3(6)(7), §9.4(4)).
 *
 * They are tested together because the WS messages are just envelopes around the
 * other two, and the sample snapshot and effects below are the payloads.
 */

const SNAPSHOT: WorldSnapshot = {
  schemaVersion: CONTRACT_VERSION,
  stateRevision: 42,
  processedIngestSeq: 128,
  worldTimeUtc: '2026-08-16T00:10:00.000Z',
  inputMode: 'direct',
  interactionEnabled: true,
  broadcastLifecycle: 'live',
  creature: {
    creatureId: 'test_creature_a',
    lifeStage: 'test_stage_juvenile',
    growthStage: 'test_growth_2',
    needId: 'test_need_hunger',
    emotionId: 'test_emotion_calm',
    bondProgress: { current: 3, target: 10 },
    growthProgress: { current: 1, target: 4 },
  },
  mission: {
    missionId: 'test_mission_a',
    progress: { current: 0, target: 3 },
    choices: [
      { choiceId: 'test_choice_a', labelKey: 'mission.choice_a', commandName: 'VOTE_A' },
      { choiceId: 'test_choice_b', labelKey: 'mission.choice_b', commandName: 'VOTE_B' },
    ],
    choiceClosesAt: '2026-08-16T00:12:00.000Z',
  },
  environment: {
    environmentId: 'test_environment_meadow',
    worldPhaseId: 'test_phase_morning',
    weatherId: 'test_weather_clear',
    chapterId: 'test_chapter_1',
    chapterProgress: { current: 2, target: 5 },
  },
  nextTransitionAt: '2026-08-16T00:15:00.000Z',
  display: {
    currentNeedOrMission: { textKey: 'need.hungry', iconId: 'test_icon_hunger' },
    lastAppliedAction: {
      commandName: 'FEED',
      appliedAt: '2026-08-16T00:09:30.000Z',
      contributionCount: 7,
    },
    growthOrChapterProgress: { textKey: 'progress.chapter', progress: { current: 2, target: 5 } },
    nextChoiceAt: '2026-08-16T00:12:00.000Z',
  },
}

const ACTION_REACTION: Effect = {
  schemaVersion: CONTRACT_VERSION,
  effectId: 'eff_test_0001',
  kind: 'ACTION_REACTION',
  causedByEventKey: 'youtube:bcast_test_0001:msg_test_0001',
  stateRevision: 42,
  startsAt: '2026-08-16T00:10:00.000Z',
  endsAt: '2026-08-16T00:10:04.000Z',
  paid: false,
  payload: { commandName: 'FEED', contributionCount: 7 },
}

const PAID_THANKS: Effect = {
  schemaVersion: CONTRACT_VERSION,
  effectId: 'eff_test_0002',
  kind: 'PAID_THANKS',
  causedByEventKey: 'youtube:bcast_test_0001:msg_test_0003',
  stateRevision: 43,
  startsAt: '2026-08-16T00:11:00.000Z',
  endsAt: '2026-08-16T00:11:06.000Z',
  paid: true,
  payload: { paidEventKind: 'SUPER_CHAT', iconId: 'test_icon_thanks', tier: 2, fallback: false },
}

const AMBIENCE: Effect = {
  schemaVersion: CONTRACT_VERSION,
  effectId: 'eff_test_0003',
  kind: 'AMBIENCE',
  causedByEventKey: 'simulator:bcast_test_0001:msg_test_0100',
  stateRevision: 44,
  startsAt: '2026-08-16T00:12:00.000Z',
  endsAt: '2026-08-16T00:22:00.000Z',
  paid: false,
  payload: { ambienceId: 'test_ambience_dusk' },
}

const MISSION_UPDATE: Effect = {
  schemaVersion: CONTRACT_VERSION,
  effectId: 'eff_test_0004',
  kind: 'MISSION_UPDATE',
  causedByEventKey: 'youtube:bcast_test_0001:msg_test_0002',
  stateRevision: 45,
  startsAt: '2026-08-16T00:13:00.000Z',
  endsAt: '2026-08-16T00:13:03.000Z',
  paid: false,
  payload: { missionId: 'test_mission_a', phase: 'STARTED' },
}

const EFFECTS = [ACTION_REACTION, PAID_THANKS, AMBIENCE, MISSION_UPDATE]

describe('enums fixed by the spec', () => {
  it('has the six broadcast lifecycle states of §9.2', () => {
    expect(BroadcastLifecycleSchema.options).toEqual([
      'offline',
      'starting',
      'live',
      'degraded',
      'recovering',
      'safe_stopped',
    ])
  })

  it('has the two input modes of §6.4 and the three deadline policies of §10.2', () => {
    expect(InputModeSchema.options).toEqual(['direct', 'aggregate'])
    expect(DeadlinePolicySchema.options).toEqual(['replay', 'coalesce', 'skip'])
  })
})

describe('WorldSnapshot (spec §6.3)', () => {
  it('accepts the full read model', () => {
    expect(WorldSnapshotSchema.parse(SNAPSHOT)).toEqual(SNAPSHOT)
  })

  it('accepts a world with no active mission and no open choice', () => {
    const idle = {
      ...SNAPSHOT,
      mission: null,
      display: { ...SNAPSHOT.display, lastAppliedAction: null, nextChoiceAt: null },
    }
    expect(WorldSnapshotSchema.safeParse(idle).success).toBe(true)
  })

  it('accepts the optional season block and aggregate window (spec §6.3, §6.4)', () => {
    const withOptional = {
      ...SNAPSHOT,
      inputMode: 'aggregate' as const,
      season: { seasonId: 'test_season_1', previousSeasonMementoIds: ['test_memento_a'] },
      display: {
        ...SNAPSHOT.display,
        aggregateWindow: {
          mode: 'aggregate' as const,
          endsAt: '2026-08-16T00:10:20.000Z',
          tallies: [
            { commandName: 'VOTE_A' as const, count: 12 },
            { commandName: 'VOTE_B' as const, count: 9 },
          ],
        },
      },
    }
    expect(WorldSnapshotSchema.safeParse(withOptional).success).toBe(true)
  })

  it('carries every §5.2 display slot', () => {
    expect(Object.keys(SNAPSHOT.display).sort()).toEqual([
      'currentNeedOrMission',
      'growthOrChapterProgress',
      'lastAppliedAction',
      'nextChoiceAt',
    ])
  })

  it('refuses a sentence in a display slot — the screen gets i18n keys, not text', () => {
    const withRawChat = {
      ...SNAPSHOT,
      display: {
        ...SNAPSHOT.display,
        currentNeedOrMission: {
          textKey: 'ごはん あげて！ https://example.invalid',
          iconId: 'test_icon_hunger',
        },
      },
    }
    expect(WorldSnapshotSchema.safeParse(withRawChat).success).toBe(false)
  })

  it('refuses an added identity field', () => {
    expect(
      WorldSnapshotSchema.safeParse({ ...SNAPSHOT, lastSupporterName: 'someone' }).success,
    ).toBe(false)
  })

  it('refuses a lifecycle value outside §9.2', () => {
    expect(WorldSnapshotSchema.safeParse({ ...SNAPSHOT, broadcastLifecycle: 'dead' }).success).toBe(
      false,
    )
  })

  it('refuses a relative time in nextTransitionAt', () => {
    expect(WorldSnapshotSchema.safeParse({ ...SNAPSHOT, nextTransitionAt: '+5m' }).success).toBe(
      false,
    )
  })
})

describe('Effect (spec §7.3(6), §8.4)', () => {
  it.each(EFFECTS)('accepts the $kind variant', (effect) => {
    expect(EffectSchema.parse(effect)).toEqual(effect)
  })

  it('keeps paid and free effects apart by construction', () => {
    // A free command reaction can never be recorded as paid, and a thanks
    // animation can never be recorded as free: `paid` is a literal per variant,
    // so the paid ledger and the audit trail cannot disagree (spec §8.4).
    expect(ActionReactionEffectSchema.safeParse({ ...ACTION_REACTION, paid: true }).success).toBe(
      false,
    )
    expect(PaidThanksEffectSchema.safeParse({ ...PAID_THANKS, paid: false }).success).toBe(false)
  })

  it('refuses a supporter name in a payload', () => {
    expect(
      EffectSchema.safeParse({
        ...PAID_THANKS,
        payload: { ...PAID_THANKS.payload, displayName: 'someone' },
      }).success,
    ).toBe(false)
  })

  it('refuses a relative staging window', () => {
    expect(EffectSchema.safeParse({ ...ACTION_REACTION, endsAt: '4s' }).success).toBe(false)
  })

  it('refuses an effect with no causing event key', () => {
    expect(EffectSchema.safeParse({ ...ACTION_REACTION, causedByEventKey: null }).success).toBe(
      false,
    )
  })

  it('refuses an unknown effect kind', () => {
    expect(EffectSchema.safeParse({ ...ACTION_REACTION, kind: 'REVIVE' }).success).toBe(false)
  })
})

describe('WS protocol on /ws/renderer', () => {
  const sentAt = '2026-08-16T00:10:00.100Z'

  const SERVER_MESSAGES = [
    { schemaVersion: CONTRACT_VERSION, sentAt, type: 'snapshot', snapshot: SNAPSHOT },
    { schemaVersion: CONTRACT_VERSION, sentAt, type: 'effect', effect: PAID_THANKS },
    { schemaVersion: CONTRACT_VERSION, sentAt, type: 'ping' },
  ]

  const RENDERER_MESSAGES = [
    {
      schemaVersion: CONTRACT_VERSION,
      type: 'hello',
      rendererId: 'renderer_test_0001',
      lastAppliedStateRevision: null,
    },
    {
      schemaVersion: CONTRACT_VERSION,
      type: 'ack_state',
      stateRevision: 42,
      appliedAt: '2026-08-16T00:10:00.250Z',
    },
    {
      schemaVersion: CONTRACT_VERSION,
      type: 'ack_effect',
      effectId: 'eff_test_0002',
      appliedAt: '2026-08-16T00:11:00.250Z',
    },
    {
      schemaVersion: CONTRACT_VERSION,
      type: 'renderer_health',
      frameCounter: 108_000,
      fps: 59.4,
      webglContextLost: false,
      lastAppliedStateRevision: 42,
      lastAppliedEffectId: 'eff_test_0002',
    },
  ]

  it.each(SERVER_MESSAGES)('accepts the server $type message', (message) => {
    expect(ServerToRendererMessageSchema.parse(message)).toEqual(message)
  })

  it.each(RENDERER_MESSAGES)('accepts the renderer $type message', (message) => {
    expect(RendererToServerMessageSchema.parse(message)).toEqual(message)
  })

  it('carries exactly the three server message types', () => {
    expect(SERVER_MESSAGES.map((m) => m.type)).toEqual(['snapshot', 'effect', 'ping'])
    expect(
      ServerToRendererMessageSchema.safeParse({ ...SERVER_MESSAGES[2], type: 'delta' }).success,
    ).toBe(false)
  })

  it('carries exactly the four renderer message types', () => {
    expect(RENDERER_MESSAGES.map((m) => m.type)).toEqual([
      'hello',
      'ack_state',
      'ack_effect',
      'renderer_health',
    ])
  })

  it('does not accept a renderer message on the server channel', () => {
    expect(ServerToRendererMessageSchema.safeParse(RENDERER_MESSAGES[0]).success).toBe(false)
    expect(RendererToServerMessageSchema.safeParse(SERVER_MESSAGES[2]).success).toBe(false)
  })

  it('refuses a snapshot message wrapping an invalid snapshot', () => {
    expect(
      ServerToRendererMessageSchema.safeParse({
        schemaVersion: CONTRACT_VERSION,
        sentAt,
        type: 'snapshot',
        snapshot: { ...SNAPSHOT, stateRevision: -1 },
      }).success,
    ).toBe(false)
  })

  it('refuses an ack for a revision the renderer could not have drawn', () => {
    expect(
      RendererToServerMessageSchema.safeParse({
        schemaVersion: CONTRACT_VERSION,
        type: 'ack_state',
        stateRevision: 1.5,
        appliedAt: '2026-08-16T00:10:00.250Z',
      }).success,
    ).toBe(false)
  })
})
