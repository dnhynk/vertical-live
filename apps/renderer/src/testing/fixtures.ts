import {
  CONTRACT_VERSION,
  EffectSchema,
  WorldSnapshotSchema,
  type Effect,
  type WorldSnapshot,
} from '@vl/contract'

/**
 * Obviously synthetic contract values for tests and for the local preview
 * harness (CLAUDE.md §3: fixtures carry plainly synthetic values only).
 *
 * Every identifier is prefixed `sample-`/`sample.` and every event key uses the
 * `simulator:` source, so nothing here can be mistaken for a real broadcast, a
 * real viewer or a real payment. No author field and no free text: the one name
 * here is `SAMPLE_CONSENTED_ACTOR`'s, which BOARD D-9 introduced and which says
 * in its own spelling that it was never anybody's.
 */

const SAMPLE_EVENT_KEY = 'simulator:sample-broadcast:sample-message-1'

export function sampleSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return WorldSnapshotSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    stateRevision: 1,
    processedIngestSeq: 1,
    worldTimeUtc: '2026-08-17T00:00:00.000Z',
    inputMode: 'direct',
    interactionEnabled: true,
    broadcastLifecycle: 'live',
    creature: {
      creatureId: 'sample-creature',
      lifeStage: 'sample-stage',
      growthStage: 'sample-growth',
      needId: 'sample-need',
      emotionId: 'sample-emotion',
      bondProgress: { current: 2, target: 10 },
      growthProgress: { current: 3, target: 12 },
    },
    mission: {
      missionId: 'sample-mission',
      progress: { current: 1, target: 4 },
      choices: [],
      choiceClosesAt: null,
    },
    environment: {
      environmentId: 'sample-room',
      worldPhaseId: 'sample-morning',
      weatherId: 'sample-clear',
      chapterId: 'sample-chapter',
      chapterProgress: { current: 1, target: 3 },
    },
    nextTransitionAt: '2026-08-17T00:05:00.000Z',
    display: {
      currentNeedOrMission: { textKey: 'sample.need_food', iconId: 'sample-icon-need' },
      lastAppliedAction: {
        commandName: 'FEED',
        appliedAt: '2026-08-17T00:00:30.000Z',
        contributionCount: 12,
      },
      growthOrChapterProgress: {
        textKey: 'sample.chapter_progress',
        progress: { current: 1, target: 3 },
      },
      nextChoiceAt: '2026-08-17T00:10:00.000Z',
    },
    ...overrides,
  })
}

export function sampleActionEffect(overrides: Record<string, unknown> = {}): Effect {
  return EffectSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    effectId: 'sample-effect-action-1',
    cause: { kind: 'event', eventKey: SAMPLE_EVENT_KEY },
    causedByEventKey: SAMPLE_EVENT_KEY,
    stateRevision: 1,
    startsAt: '2026-08-17T00:00:00.000Z',
    endsAt: '2026-08-17T00:00:05.000Z',
    paid: false,
    kind: 'ACTION_REACTION',
    payload: { commandName: 'FEED', contributionCount: 3 },
    ...overrides,
  })
}

/**
 * A consented viewer, as the server would put one on an `ACTION_REACTION`
 * effect (BOARD D-9, T20a).
 *
 * Both values are plainly synthetic and neither could be real: `channelRef` is
 * the opaque id the contract issues instead of a channel id, and the name says
 * what it is. No `UC…` channel id and no captured name exists anywhere in this
 * workspace (spec §2.6, §12.4).
 */
export const SAMPLE_CONSENTED_ACTOR = {
  kind: 'consented',
  displayName: 'sample-viewer-1',
  channelRef: 'ref_0123456789abcdef0123456789abcdef',
} as const

export function samplePaidThanksEffect(overrides: Record<string, unknown> = {}): Effect {
  return EffectSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    effectId: 'sample-effect-paid-1',
    cause: { kind: 'event', eventKey: SAMPLE_EVENT_KEY },
    causedByEventKey: SAMPLE_EVENT_KEY,
    stateRevision: 1,
    startsAt: '2026-08-17T00:00:00.000Z',
    endsAt: '2026-08-17T00:00:06.000Z',
    paid: true,
    kind: 'PAID_THANKS',
    payload: {
      paidEventKind: 'SUPER_CHAT',
      iconId: 'sample-icon-thanks',
      tier: 2,
      fallback: false,
    },
    ...overrides,
  })
}

/**
 * Timer-caused staging: `cause.kind === 'deadline'` and no event key (T1b,
 * BOARD A-17). Content keeps moving with zero viewers (spec §2.1, §6.2), so the
 * renderer must treat this exactly like any other effect.
 */
export function sampleDeadlineEffect(overrides: Record<string, unknown> = {}): Effect {
  return EffectSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    effectId: 'sample-effect-ambience-1',
    cause: { kind: 'deadline', deadlineKind: 'sample-weather-turn' },
    causedByEventKey: null,
    stateRevision: 1,
    startsAt: '2026-08-17T00:00:00.000Z',
    endsAt: '2026-08-17T00:00:04.000Z',
    paid: false,
    kind: 'AMBIENCE',
    payload: { ambienceId: 'sample-ambience' },
    ...overrides,
  })
}

export function snapshotMessage(snapshot: WorldSnapshot): unknown {
  return {
    schemaVersion: CONTRACT_VERSION,
    sentAt: '2026-08-17T00:00:00.000Z',
    type: 'snapshot',
    snapshot,
  }
}

export function effectMessage(effect: Effect): unknown {
  return {
    schemaVersion: CONTRACT_VERSION,
    sentAt: '2026-08-17T00:00:00.000Z',
    type: 'effect',
    effect,
  }
}

export function pingMessage(): unknown {
  return { schemaVersion: CONTRACT_VERSION, sentAt: '2026-08-17T00:00:00.000Z', type: 'ping' }
}
