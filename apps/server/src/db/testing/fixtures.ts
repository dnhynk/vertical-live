import {
  CONTRACT_VERSION,
  eventKeyFor,
  fromGrpcStreamListItem,
  giftEventKeyFor,
  type Effect,
  type IngestEnvelope,
  type WorldSnapshot,
} from '@vl/contract'
import { loadSourceFixture } from '@vl/contract/fixtures'

/**
 * Synthetic inputs for the persistence tests.
 *
 * Envelopes are built by running the real `@vl/contract` gRPC adapter over the
 * committed source fixtures, so the rows under test are the rows T9 will write.
 * Every id is an obviously fabricated test value (spec §2.6) and nothing here
 * carries an author, a display name or raw text — the contract has no field for
 * them (spec §7.3(1)).
 */

/** `live_chat_id` the committed fixtures declare; an item claiming another is rejected. */
export const TEST_LIVE_CHAT_ID = 'chat_test_0001'
export const TEST_BROADCAST_ID = 'brd_test_0001'
export const TEST_SOURCE_KEY = `youtube:${TEST_LIVE_CHAT_ID}`
export const TEST_RECEIVED_AT = '2026-08-16T00:05:00.000Z'

export function grpcEnvelope(
  fixtureName: string,
  receivedAt: string = TEST_RECEIVED_AT,
): IngestEnvelope {
  return fromGrpcStreamListItem(loadSourceFixture('grpc', fixtureName).item, {
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt,
    // T6 owns command parsing; the persistence layer only stores the result.
    parseCommand: () => null,
  })
}

export function checkpointInput(nextPageToken: string | null = 'token_test_0001'): {
  sourceKey: string
  liveChatId: string
  nextPageToken: string | null
} {
  return {
    sourceKey: TEST_SOURCE_KEY,
    liveChatId: TEST_LIVE_CHAT_ID,
    nextPageToken,
  }
}

export interface SnapshotOverrides {
  readonly stateRevision?: number
  readonly processedIngestSeq?: number
  readonly worldTimeUtc?: string
}

/** A minimal valid `WorldSnapshot`. Content values arrive with T7. */
export function makeSnapshot(overrides: SnapshotOverrides = {}): WorldSnapshot {
  return {
    schemaVersion: CONTRACT_VERSION,
    stateRevision: overrides.stateRevision ?? 1,
    processedIngestSeq: overrides.processedIngestSeq ?? 0,
    worldTimeUtc: overrides.worldTimeUtc ?? '2026-08-16T00:05:00.000Z',
    inputMode: 'direct',
    interactionEnabled: true,
    broadcastLifecycle: 'live',
    creature: {
      creatureId: 'test_creature',
      lifeStage: 'test_stage',
      growthStage: 'test_growth',
      needId: 'test_need',
      emotionId: 'test_emotion',
      bondProgress: { current: 0, target: 100 },
      growthProgress: { current: 0, target: 100 },
    },
    mission: null,
    environment: {
      environmentId: 'test_environment',
      worldPhaseId: 'test_phase',
      weatherId: 'test_weather',
      chapterId: 'test_chapter',
      chapterProgress: { current: 0, target: 10 },
    },
    nextTransitionAt: '2026-08-16T00:10:00.000Z',
    display: {
      currentNeedOrMission: { textKey: 'test.need', iconId: 'test_icon' },
      lastAppliedAction: null,
      growthOrChapterProgress: { textKey: 'test.progress', progress: { current: 0, target: 10 } },
      nextChoiceAt: null,
    },
  }
}

export interface EffectOverrides {
  readonly effectId?: string
  readonly stateRevision?: number
  readonly causedByEventKey?: string
  readonly startsAt?: string
  readonly endsAt?: string
}

/** A paid thanks effect: the durable outbox row of spec §10.2, event-caused. */
export function makePaidEffect(overrides: EffectOverrides = {}): Effect {
  const eventKey =
    overrides.causedByEventKey ??
    eventKeyFor({
      source: 'youtube',
      broadcastId: TEST_BROADCAST_ID,
      messageId: 'msg_test_0003',
    })
  return {
    schemaVersion: CONTRACT_VERSION,
    effectId: overrides.effectId ?? 'eff_test_0001',
    cause: { kind: 'event', eventKey },
    causedByEventKey: eventKey,
    kind: 'PAID_THANKS',
    paid: true,
    stateRevision: overrides.stateRevision ?? 1,
    startsAt: overrides.startsAt ?? '2026-08-16T00:05:01.000Z',
    endsAt: overrides.endsAt ?? '2026-08-16T00:05:06.000Z',
    payload: {
      paidEventKind: 'SUPER_CHAT',
      iconId: 'test_thanks_icon',
      tier: 1,
      fallback: false,
    },
  }
}

export interface DeadlineEffectOverrides extends EffectOverrides {
  readonly deadlineKind?: string
  readonly deadlineId?: string
}

/**
 * A timer-caused effect: `causedByEventKey` is `null` because content keeps
 * moving with no viewers and no event to point at (spec §2.1, §6.2, BOARD A-17).
 */
export function makeDeadlineEffect(overrides: DeadlineEffectOverrides = {}): Effect {
  return {
    schemaVersion: CONTRACT_VERSION,
    effectId: overrides.effectId ?? 'eff_test_deadline_0001',
    cause: {
      kind: 'deadline',
      deadlineKind: overrides.deadlineKind ?? 'test_choice_window',
      ...(overrides.deadlineId === undefined ? {} : { deadlineId: overrides.deadlineId }),
    },
    causedByEventKey: null,
    kind: 'MISSION_UPDATE',
    paid: false,
    stateRevision: overrides.stateRevision ?? 1,
    startsAt: overrides.startsAt ?? '2026-08-16T00:05:01.000Z',
    endsAt: overrides.endsAt ?? '2026-08-16T00:05:06.000Z',
    payload: { missionId: 'test_mission', phase: 'PROGRESS' },
  }
}

/** Base event key of the gift fixtures, i.e. the key without the combo suffix. */
export function giftBaseKey(messageId = 'msg_test_gift_0001'): string {
  return eventKeyFor({ source: 'youtube', broadcastId: TEST_BROADCAST_ID, messageId })
}

export function giftKey(comboCount: number, messageId = 'msg_test_gift_0001'): string {
  return giftEventKeyFor({
    source: 'youtube',
    broadcastId: TEST_BROADCAST_ID,
    messageId,
    comboCount,
  })
}
