import type { CanonicalEvent, Identifier, IsoUtcInstant } from '@vl/contract'

import { addContribution, addVote, openChoiceWindow, resolveChoice } from './choices.js'
import { chapterDefinition, CHAPTER_DEFINITIONS } from './content/chapters.js'
import { DEFAULT_WORLD_TUNING, type WorldTuning } from './content/tuning.js'
import {
  CRISIS_ENTER_VARIANTS,
  CRISIS_RECOVERY_VARIANTS,
  IDLE_VARIANTS,
  MISSION_VARIANTS,
  PHASE_AMBIENCE,
  REACTION_VARIANTS,
  VISITOR_VARIANTS,
  WEATHER_VARIANTS,
  type ContentContext,
  type MissionVariant,
} from './content/variants.js'
import {
  addBond,
  addGrowth,
  deriveEmotion,
  dominantNeed,
  evaluateCrisis,
  growthStageOf,
  growthTargetFor,
  integrateNeeds,
  mapNeeds,
} from './creature.js'
import { removeDeadline, replaceDeadline, scheduleDeadline } from './deadlines.js'
import {
  applyPaidEvent,
  applyThanksFallback,
  paidEventKindOf,
  paidFallbackDeadlines,
} from './paid.js'
import { createRng, type Rng } from './rng.js'
import {
  addMillis,
  millisBetween,
  nextJstHour,
  nextWorldPhaseAt,
  toMillis,
  worldPhaseAt,
  MILLIS_PER_DAY,
} from './time.js'
import { rememberVariant, sceneKeyFor, selectVariant } from './variation.js'
import {
  CARE_COMMANDS,
  VOTE_COMMANDS,
  type AuditState,
  type CareCommand,
  type ChapterBeat,
  type ChapterId,
  type EffectCause,
  type EffectDraft,
  type GameState,
  type InputRejection,
  type MissionDomainState,
  type RejectionReason,
  type ScheduledDeadline,
  type StepInput,
  type StepResult,
  type VoteCommand,
  type WorldState,
  type WorldTransition,
} from './types.js'

/**
 * The content director: one pure reducer over (state, input, now, rng).
 *
 * It performs no I/O, reads no clock and starts no timer — every time it needs
 * comes in as `now`, every random draw comes from the injected `rng`, and every
 * future wake-up leaves as a `ScheduledDeadline` with a §10.2 policy attached.
 * That is what lets the state engine (T8) persist, replay and recover a world
 * that the renderer only reads (spec §10.2).
 *
 * Structural guarantees worth naming, because they are the invariants of
 * `CLAUDE.md` §3 rather than nice-to-haves:
 * - paid input reaches only `applyPaidEvent`, which cannot return a `GameState`
 *   and is not given the `rng` — payment therefore buys no state, no odds and no
 *   vote weight (spec §8.5);
 * - the creature has no death or decay path: growth is monotonic and the three
 *   crisis states recover with elapsed time alone (spec §6.3);
 * - nothing here holds an author, a name or a chat line — the world speaks in
 *   identifiers and i18n keys (spec §7.3(1), §12.3).
 */

export interface StepOptions {
  /** Overrides the provisional content tuning (BOARD A-15); T8 feeds config. */
  readonly tuning?: WorldTuning
}

/** Largest contribution count one aggregated event may claim (spec §6.4). */
const MAX_CONTRIBUTIONS = 10_000

const CARE_NEED: Readonly<Record<CareCommand, 'hungry' | 'play' | 'affection'>> = {
  FEED: 'hungry',
  PLAY: 'play',
  PET: 'affection',
}

interface Draft {
  world: GameState
  audit: AuditState
  readonly transitions: WorldTransition[]
  readonly effects: EffectDraft[]
  readonly rejections: InputRejection[]
}

export function contextOf(world: GameState): ContentContext {
  return {
    phase: world.environment.worldPhaseId,
    weather: world.environment.weatherId,
    environment: world.environment.environmentId,
    chapter: world.chapter.chapterId,
    beat: world.chapter.beat,
    crisis: world.creature.crisis,
    emotion: world.creature.emotionId,
    dominantNeed: dominantNeed(world.creature.needs),
    growthStage: growthStageOf(world.creature.growthStageIndex),
    visitor: world.environment.visitorId,
  }
}

function record(draft: Draft, transition: WorldTransition): void {
  draft.transitions.push(transition)
}

/** Emits an `AMBIENCE` draft and remembers the variant for §12.5 avoidance. */
function stage(
  draft: Draft,
  cause: EffectCause,
  ambienceId: Identifier,
  variantId: Identifier | null,
  now: IsoUtcInstant,
  tuning: WorldTuning,
): string | null {
  const context = contextOf(draft.world)
  const sceneKey = variantId === null ? null : sceneKeyFor(variantId, context)
  draft.effects.push({
    kind: 'AMBIENCE',
    paid: false,
    cause,
    variantId,
    startsAt: now,
    endsAt: addMillis(now, tuning.staging.ambienceMs),
    payload: { ambienceId },
  })
  draft.world = {
    ...draft.world,
    variation: rememberVariant(draft.world.variation, variantId, sceneKey, tuning),
  }
  return sceneKey
}

function reject(
  draft: Draft,
  reason: RejectionReason,
  event: CanonicalEvent | null,
  now: IsoUtcInstant,
): void {
  draft.rejections.push({ reason, eventKey: event?.eventKey ?? null, at: now })
}

// ---------------------------------------------------------------------------
// Creature bookkeeping shared by the event and deadline paths
// ---------------------------------------------------------------------------

/** Integrates needs, then re-derives crisis and emotion, recording what moved. */
function refreshCreature(
  draft: Draft,
  now: IsoUtcInstant,
  rng: Rng,
  tuning: WorldTuning,
  cause: WorldTransition['cause'],
  effectCause: EffectCause,
): void {
  const before = draft.world.creature
  const integrated = integrateNeeds(before, now, tuning)
  const crisis = evaluateCrisis(
    integrated.needs,
    draft.world.environment.worldPhaseId,
    integrated.crisis,
    tuning,
  )
  const emotionId = deriveEmotion(integrated.needs, crisis)
  draft.world = {
    ...draft.world,
    creature: {
      ...integrated,
      crisis,
      crisisSince: crisis === null ? null : (integrated.crisisSince ?? now),
      emotionId,
    },
  }

  if (crisis !== before.crisis) {
    const entering = crisis !== null
    const variants = entering
      ? CRISIS_ENTER_VARIANTS[crisis]
      : CRISIS_RECOVERY_VARIANTS[before.crisis ?? 'tired']
    const variant = selectVariant(variants, contextOf(draft.world), draft.world.variation, rng)
    const sceneKey =
      variant === null
        ? null
        : stage(draft, effectCause, variant.ambienceId, variant.variantId, now, tuning)
    record(draft, {
      type: entering ? 'crisis_entered' : 'crisis_recovered',
      at: now,
      variantId: variant?.variantId ?? null,
      from: before.crisis,
      to: crisis ?? 'well',
      cause,
      sceneKey,
    })
    // A crisis schedules its own recovery check; leaving one cancels it.
    draft.world = {
      ...draft.world,
      deadlines: entering
        ? replaceDeadline(
            draft.world.deadlines,
            scheduleDeadline('crisis_recovery', addMillis(now, tuning.crisis.recoveryIntervalMs)),
          )
        : removeDeadline(draft.world.deadlines, 'crisis_recovery'),
    }
  }

  if (emotionId !== before.emotionId) {
    record(draft, {
      type: 'emotion_changed',
      at: now,
      variantId: null,
      from: before.emotionId,
      to: emotionId,
      cause,
      sceneKey: null,
    })
  }
}

function grantGrowth(
  draft: Draft,
  amount: number,
  now: IsoUtcInstant,
  tuning: WorldTuning,
  cause: WorldTransition['cause'],
): void {
  if (amount <= 0) return
  const result = addGrowth(draft.world.creature, amount, tuning)
  draft.world = { ...draft.world, creature: result.creature }
  record(draft, {
    type: 'growth_progress',
    at: now,
    variantId: null,
    from: null,
    to: growthStageOf(result.creature.growthStageIndex),
    cause,
    sceneKey: null,
  })
  if (result.advancedFrom !== null) {
    record(draft, {
      type: 'growth_stage_advanced',
      at: now,
      variantId: null,
      from: result.advancedFrom,
      to: growthStageOf(result.creature.growthStageIndex),
      cause,
      sceneKey: null,
    })
  }
}

function grantBond(
  draft: Draft,
  amount: number,
  now: IsoUtcInstant,
  cause: WorldTransition['cause'],
): void {
  if (amount <= 0) return
  draft.world = { ...draft.world, creature: addBond(draft.world.creature, amount) }
  record(draft, {
    type: 'bond_progress',
    at: now,
    variantId: null,
    from: null,
    to: 'bond',
    cause,
    sceneKey: null,
  })
}

// ---------------------------------------------------------------------------
// Missions (minutes scale, spec §6.2)
// ---------------------------------------------------------------------------

function selectMissionVariant(
  context: ContentContext,
  draft: Draft,
  rng: Rng,
  bias: MissionVariant['missionId'] | null,
): MissionVariant | null {
  const biased =
    bias === null ? [] : MISSION_VARIANTS.filter((variant) => variant.missionId === bias)
  const biasedPick =
    biased.length === 0 ? null : selectVariant(biased, context, draft.world.variation, rng)
  return biasedPick ?? selectVariant(MISSION_VARIANTS, context, draft.world.variation, rng)
}

function startMission(
  draft: Draft,
  now: IsoUtcInstant,
  rng: Rng,
  tuning: WorldTuning,
  cause: WorldTransition['cause'],
): void {
  const context = contextOf(draft.world)
  const bias = draft.world.chapter.branchChoiceId === null ? null : missionBiasOf(draft.world)
  const variant = selectMissionVariant(context, draft, rng, bias) ?? MISSION_VARIANTS[0] ?? null
  if (variant === null) return
  const mission: MissionDomainState = {
    missionId: variant.missionId,
    variantId: variant.variantId,
    progress: { current: 0, target: tuning.mission.targetContributions },
    startedAt: now,
    closesAt: addMillis(now, tuning.mission.durationMs),
    contributions: {},
  }
  draft.world = {
    ...draft.world,
    mission,
    deadlines: replaceDeadline(
      draft.world.deadlines,
      scheduleDeadline('mission_close', mission.closesAt),
    ),
  }
  const effectCause: EffectCause = { kind: 'deadline', deadlineKind: 'mission_close' }
  draft.effects.push({
    kind: 'MISSION_UPDATE',
    paid: false,
    cause: effectCause,
    variantId: variant.variantId,
    startsAt: now,
    endsAt: addMillis(now, tuning.staging.missionMs),
    payload: { missionId: mission.missionId, phase: 'STARTED' },
  })
  const sceneKey = stage(draft, effectCause, variant.ambienceId, variant.variantId, now, tuning)
  record(draft, {
    type: 'mission_started',
    at: now,
    variantId: variant.variantId,
    from: null,
    to: mission.missionId,
    cause,
    sceneKey,
  })
}

function missionBiasOf(world: GameState): MissionVariant['missionId'] | null {
  const chapter = chapterDefinition(world.chapter.chapterId)
  const option = chapter.options.find((it) => it.choiceId === world.chapter.branchChoiceId)
  return option?.missionBias ?? null
}

function resolveMission(
  draft: Draft,
  now: IsoUtcInstant,
  rng: Rng,
  tuning: WorldTuning,
  cause: WorldTransition['cause'],
): void {
  const mission = draft.world.mission
  const completed = mission.progress.current >= mission.progress.target
  draft.effects.push({
    kind: 'MISSION_UPDATE',
    paid: false,
    cause: { kind: 'deadline', deadlineKind: 'mission_close' },
    variantId: mission.variantId,
    startsAt: now,
    endsAt: addMillis(now, tuning.staging.missionMs),
    payload: { missionId: mission.missionId, phase: 'COMPLETED' },
  })
  record(draft, {
    type: 'mission_resolved',
    at: now,
    variantId: mission.variantId,
    from: mission.missionId,
    // Running out of time is not a failure: spec §5.3 forbids permanent loss for
    // missed time, so an unfinished mission simply resolves more quietly.
    to: completed ? 'completed' : 'eased',
    cause,
    sceneKey: null,
  })
  grantGrowth(
    draft,
    completed ? tuning.mission.growthOnCompleted : tuning.mission.growthOnEased,
    now,
    tuning,
    cause,
  )
  if (completed) grantBond(draft, tuning.mission.bondOnCompleted, now, cause)
  startMission(draft, now, rng, tuning, cause)
}

// ---------------------------------------------------------------------------
// Chapters (day scale, spec §6.2)
// ---------------------------------------------------------------------------

/** Absolute end of a chapter that started at `startedAt` (spec §5.3 JST base). */
export function chapterEndFor(startedAt: IsoUtcInstant, tuning: WorldTuning): IsoUtcInstant {
  let candidate = nextJstHour(startedAt, tuning.chapter.anchorHourJst)
  while (millisBetween(candidate, startedAt) < tuning.chapter.minFirstDurationMs) {
    candidate = addMillis(candidate, MILLIS_PER_DAY)
  }
  return candidate
}

function beatDueAt(
  startedAt: IsoUtcInstant,
  endsAt: IsoUtcInstant,
  beat: ChapterBeat,
  tuning: WorldTuning,
): IsoUtcInstant {
  const duration = millisBetween(endsAt, startedAt)
  if (beat === 'setup') return startedAt
  const fraction = beat === 'turn' ? tuning.chapter.turnFraction : tuning.chapter.resolutionFraction
  return addMillis(startedAt, Math.round(duration * fraction))
}

function pickChapterId(previous: ChapterId, rng: Rng): ChapterId {
  const alternatives = CHAPTER_DEFINITIONS.filter((it) => it.chapterId !== previous)
  const pool = alternatives.length > 0 ? alternatives : CHAPTER_DEFINITIONS
  return rng.pickWeighted(pool, (it) => it.weight)?.chapterId ?? previous
}

function rolloverChapter(draft: Draft, now: IsoUtcInstant, rng: Rng, tuning: WorldTuning): void {
  const previous = draft.world.chapter
  const chapterId = pickChapterId(previous.chapterId, rng)
  draft.world = {
    ...draft.world,
    chapter: {
      chapterId,
      dayIndex: previous.dayIndex + 1,
      startedAt: now,
      endsAt: chapterEndFor(now, tuning),
      beat: 'setup',
      beatsPlayed: [],
      branchChoiceId: null,
      resolved: false,
    },
  }
}

function playChapterBeat(
  draft: Draft,
  beat: ChapterBeat,
  now: IsoUtcInstant,
  rng: Rng,
  tuning: WorldTuning,
): void {
  if (beat === 'setup' && draft.world.chapter.resolved) rolloverChapter(draft, now, rng, tuning)

  const chapter = chapterDefinition(draft.world.chapter.chapterId)
  const ambienceId =
    beat === 'setup'
      ? chapter.setupAmbienceId
      : beat === 'turn'
        ? chapter.turnAmbienceId
        : chapter.resolutionAmbienceId
  const cause: EffectCause = { kind: 'deadline', deadlineKind: 'chapter_beat', deadlineId: beat }

  draft.world = {
    ...draft.world,
    chapter: {
      ...draft.world.chapter,
      beat,
      beatsPlayed: draft.world.chapter.beatsPlayed.includes(beat)
        ? draft.world.chapter.beatsPlayed
        : [...draft.world.chapter.beatsPlayed, beat],
    },
  }
  const sceneKey = stage(draft, cause, ambienceId, `${chapter.chapterId}_${beat}`, now, tuning)

  if (beat === 'setup') {
    record(draft, {
      type: 'chapter_started',
      at: now,
      variantId: null,
      from: null,
      to: chapter.chapterId,
      cause: 'director',
      sceneKey,
    })
  } else {
    record(draft, {
      type: beat === 'resolution' ? 'chapter_resolved' : 'chapter_beat',
      at: now,
      variantId: draft.world.chapter.branchChoiceId,
      from: chapter.chapterId,
      to: beat,
      cause: 'director',
      sceneKey,
    })
  }

  if (beat === 'turn') {
    const choice = openChoiceWindow(
      draft.world.chapter.chapterId,
      draft.world.identity.gateOpen,
      now,
      tuning,
    )
    draft.world = {
      ...draft.world,
      choice,
      deadlines: replaceDeadline(
        draft.world.deadlines,
        scheduleDeadline('choice_close', choice.closesAt),
      ),
    }
    record(draft, {
      type: 'choice_opened',
      at: now,
      variantId: null,
      from: chapter.chapterId,
      to: choice.mode,
      cause: 'director',
      sceneKey: null,
    })
  }

  if (beat === 'resolution') {
    draft.world = { ...draft.world, chapter: { ...draft.world.chapter, resolved: true } }
    grantGrowth(draft, tuning.chapter.growthOnResolution, now, tuning, 'director')
    grantBond(draft, tuning.chapter.bondOnResolution, now, 'director')
  }

  const nextBeat: ChapterBeat | null =
    beat === 'setup' ? 'turn' : beat === 'turn' ? 'resolution' : 'setup'
  const nextDueAt =
    nextBeat === 'setup'
      ? draft.world.chapter.endsAt
      : beatDueAt(draft.world.chapter.startedAt, draft.world.chapter.endsAt, nextBeat, tuning)
  draft.world = {
    ...draft.world,
    deadlines: replaceDeadline(
      draft.world.deadlines,
      scheduleDeadline('chapter_beat', nextDueAt, nextBeat),
    ),
  }
}

// ---------------------------------------------------------------------------
// Event inputs
// ---------------------------------------------------------------------------

function isCareCommand(name: string): name is CareCommand {
  return (CARE_COMMANDS as readonly string[]).includes(name)
}

function isVoteCommand(name: string): name is VoteCommand {
  return (VOTE_COMMANDS as readonly string[]).includes(name)
}

function applyCareCommand(
  draft: Draft,
  event: CanonicalEvent,
  command: CareCommand,
  contributions: number,
  now: IsoUtcInstant,
  rng: Rng,
  tuning: WorldTuning,
): void {
  const cause: EffectCause = { kind: 'event', eventKey: event.eventKey }
  refreshCreature(draft, now, rng, tuning, 'command', cause)

  const need = CARE_NEED[command]
  const relief =
    tuning.needs.relief[command] + (contributions - 1) * tuning.needs.reliefPerExtraContribution
  const before = draft.world.creature
  draft.world = {
    ...draft.world,
    creature: {
      ...before,
      needs: mapNeeds(before.needs, (id, value) => (id === need ? value - relief : value)),
    },
  }
  record(draft, {
    type: 'need_relieved',
    at: now,
    variantId: null,
    from: need,
    to: command,
    cause: 'command',
    sceneKey: null,
  })

  grantBond(draft, tuning.mission.bondPerContribution * contributions, now, 'command')
  grantGrowth(draft, tuning.mission.growthPerContribution * contributions, now, tuning, 'command')

  // The staging variant is what keeps the same command from looking the same
  // twice (spec §12.5): eligibility depends on need, crisis, weather and chapter.
  const variant = selectVariant(
    REACTION_VARIANTS[command],
    contextOf(draft.world),
    draft.world.variation,
    rng,
  )
  draft.effects.push({
    kind: 'ACTION_REACTION',
    paid: false,
    cause,
    variantId: variant?.variantId ?? null,
    startsAt: now,
    endsAt: addMillis(now, tuning.staging.reactionMs),
    payload: { commandName: command, contributionCount: contributions },
  })
  if (variant !== null) stage(draft, cause, variant.ambienceId, variant.variantId, now, tuning)

  draft.world = {
    ...draft.world,
    lastAppliedAction: { commandName: command, appliedAt: now, contributionCount: contributions },
  }

  // Mission progress, when this mission responds to this command.
  const missionVariant = MISSION_VARIANTS.find(
    (it) => it.variantId === draft.world.mission.variantId,
  )
  if (missionVariant?.command === command) {
    const mission = draft.world.mission
    const current = Math.min(mission.progress.target, mission.progress.current + contributions)
    draft.world = {
      ...draft.world,
      mission: {
        ...mission,
        progress: { ...mission.progress, current },
        contributions: {
          ...mission.contributions,
          [command]: (mission.contributions[command] ?? 0) + contributions,
        },
      },
    }
    draft.effects.push({
      kind: 'MISSION_UPDATE',
      paid: false,
      cause,
      variantId: mission.variantId,
      startsAt: now,
      endsAt: addMillis(now, tuning.staging.missionMs),
      payload: { missionId: mission.missionId, phase: 'PROGRESS' },
    })
    record(draft, {
      type: 'mission_progress',
      at: now,
      variantId: mission.variantId,
      from: mission.missionId,
      to: command,
      cause: 'command',
      sceneKey: null,
    })
    if (current >= mission.progress.target) {
      draft.world = {
        ...draft.world,
        deadlines: removeDeadline(draft.world.deadlines, 'mission_close'),
      }
      resolveMission(draft, now, rng, tuning, 'command')
    }
  }

  // Non-competitive room total for the open branch (spec §6.4).
  if (draft.world.choice !== null) {
    draft.world = {
      ...draft.world,
      choice: addContribution(draft.world.choice, command, contributions),
    }
  }

  refreshCreature(draft, now, rng, tuning, 'command', cause)
}

function applyVoteCommand(
  draft: Draft,
  event: CanonicalEvent,
  command: VoteCommand,
  now: IsoUtcInstant,
): void {
  // Spec §6.4: a per-user branch vote needs the identity gate. With the gate
  // closed the vote is refused here as well as in the parser (T6), so no path
  // can quietly start counting per-user ballots (BOARD A-1, A-9).
  if (!draft.world.identity.gateOpen) {
    reject(draft, 'vote_disabled', event, now)
    return
  }
  const choice = draft.world.choice
  if (choice === null || choice.mode !== 'vote' || toMillis(now) > toMillis(choice.closesAt)) {
    reject(draft, 'vote_window_closed', event, now)
    return
  }
  if (!choice.options.some((option) => option.commandName === command)) {
    reject(draft, 'unknown_choice', event, now)
    return
  }
  draft.world = { ...draft.world, choice: addVote(choice, command) }
}

function applyEvent(
  draft: Draft,
  event: CanonicalEvent,
  contributions: number,
  now: IsoUtcInstant,
  rng: Rng,
  tuning: WorldTuning,
): void {
  const paidEventKind = paidEventKindOf(event)
  if (paidEventKind !== null) {
    // Audit only, and `draft.world` is deliberately never assigned on this path:
    // that is the §8.5 guarantee in its strongest form. A command riding along on
    // a paid message is not executed either — acting on it would make the payment
    // buy an action.
    const result = applyPaidEvent(draft.audit, event, paidEventKind, now, tuning)
    draft.audit = result.audit
    draft.effects.push(...result.effects)
    draft.transitions.push(...result.transitions)
    draft.rejections.push(...result.rejections)
    return
  }

  const command = event.command
  if (event.kind !== 'CHAT_COMMAND' || command === null) {
    reject(draft, 'not_a_world_input', event, now)
    return
  }
  if (isCareCommand(command.name)) {
    applyCareCommand(draft, event, command.name, contributions, now, rng, tuning)
    return
  }
  if (isVoteCommand(command.name)) {
    applyVoteCommand(draft, event, command.name, now)
    return
  }
  reject(draft, 'not_a_world_input', event, now)
}

// ---------------------------------------------------------------------------
// Deadline inputs
// ---------------------------------------------------------------------------

function applyIdleBeat(draft: Draft, now: IsoUtcInstant, rng: Rng, tuning: WorldTuning): void {
  const cause: EffectCause = { kind: 'deadline', deadlineKind: 'idle_beat' }
  const variant = selectVariant(IDLE_VARIANTS, contextOf(draft.world), draft.world.variation, rng)
  if (variant !== null) {
    const sceneKey = stage(draft, cause, variant.ambienceId, variant.variantId, now, tuning)
    record(draft, {
      type: 'idle_beat',
      at: now,
      variantId: variant.variantId,
      from: null,
      to: variant.ambienceId,
      cause: 'deadline',
      sceneKey,
    })
  }
  const span = tuning.idleBeat.maxIntervalMs - tuning.idleBeat.minIntervalMs
  const nextAt = addMillis(now, tuning.idleBeat.minIntervalMs + rng.nextInt(Math.max(1, span)))
  draft.world = {
    ...draft.world,
    deadlines: replaceDeadline(draft.world.deadlines, scheduleDeadline('idle_beat', nextAt)),
  }
}

function applyNeedDecay(draft: Draft, now: IsoUtcInstant, rng: Rng, tuning: WorldTuning): void {
  const before = dominantNeed(draft.world.creature.needs)
  refreshCreature(draft, now, rng, tuning, 'deadline', {
    kind: 'deadline',
    deadlineKind: 'need_decay',
  })
  const after = dominantNeed(draft.world.creature.needs)
  if (after !== before) {
    record(draft, {
      type: 'need_pressure',
      at: now,
      variantId: null,
      from: before,
      to: after,
      cause: 'deadline',
      sceneKey: null,
    })
  }
  draft.world = {
    ...draft.world,
    deadlines: replaceDeadline(
      draft.world.deadlines,
      scheduleDeadline('need_decay', addMillis(now, tuning.needs.decayIntervalMs)),
    ),
  }
}

function applyChoiceClose(draft: Draft, now: IsoUtcInstant, rng: Rng, tuning: WorldTuning): void {
  const choice = draft.world.choice
  draft.world = {
    ...draft.world,
    choice: null,
    deadlines: removeDeadline(draft.world.deadlines, 'choice_close'),
  }
  if (choice === null) return
  const resolution = resolveChoice(choice, contextOf(draft.world), rng, tuning)
  if (resolution === null) return

  const chapter = chapterDefinition(choice.choiceSetId)
  const option = chapter.options.find((it) => it.choiceId === resolution.option.choiceId)
  draft.world = {
    ...draft.world,
    chapter: { ...draft.world.chapter, branchChoiceId: resolution.option.choiceId },
    environment:
      option === undefined
        ? draft.world.environment
        : { ...draft.world.environment, environmentId: option.environmentId },
  }
  const cause: EffectCause = { kind: 'deadline', deadlineKind: 'choice_close' }
  const sceneKey =
    option === undefined
      ? null
      : stage(draft, cause, option.ambienceId, option.choiceId, now, tuning)
  record(draft, {
    type: 'choice_resolved',
    at: now,
    variantId: resolution.option.choiceId,
    from: choice.mode,
    to: resolution.option.eventCombinationId,
    cause: choice.mode === 'vote' ? 'command' : 'director',
    sceneKey,
  })
}

function applyWorldPhase(draft: Draft, now: IsoUtcInstant, rng: Rng, tuning: WorldTuning): void {
  const before = draft.world.environment.worldPhaseId
  const phase = worldPhaseAt(now)
  draft.world = {
    ...draft.world,
    environment: { ...draft.world.environment, worldPhaseId: phase },
    deadlines: replaceDeadline(
      draft.world.deadlines,
      scheduleDeadline('world_phase', nextWorldPhaseAt(now)),
    ),
  }
  if (phase !== before) {
    const sceneKey = stage(
      draft,
      { kind: 'deadline', deadlineKind: 'world_phase' },
      PHASE_AMBIENCE[phase],
      `phase_${phase}`,
      now,
      tuning,
    )
    record(draft, {
      type: 'phase_changed',
      at: now,
      variantId: null,
      from: before,
      to: phase,
      cause: 'deadline',
      sceneKey,
    })
  }
  // Night is what puts the creature to sleep, so re-derive after the change.
  refreshCreature(draft, now, rng, tuning, 'deadline', {
    kind: 'deadline',
    deadlineKind: 'world_phase',
  })
}

function applyWeatherChange(draft: Draft, now: IsoUtcInstant, rng: Rng, tuning: WorldTuning): void {
  const before = draft.world.environment.weatherId
  const variant = selectVariant(
    WEATHER_VARIANTS,
    contextOf(draft.world),
    draft.world.variation,
    rng,
  )
  if (variant !== null && variant.weatherId !== before) {
    draft.world = {
      ...draft.world,
      environment: { ...draft.world.environment, weatherId: variant.weatherId },
    }
    const sceneKey = stage(
      draft,
      { kind: 'deadline', deadlineKind: 'weather_change' },
      variant.ambienceId,
      variant.variantId,
      now,
      tuning,
    )
    record(draft, {
      type: 'weather_changed',
      at: now,
      variantId: variant.variantId,
      from: before,
      to: variant.weatherId,
      cause: 'deadline',
      sceneKey,
    })
  }
  draft.world = {
    ...draft.world,
    deadlines: replaceDeadline(
      draft.world.deadlines,
      scheduleDeadline('weather_change', addMillis(now, tuning.weather.intervalMs)),
    ),
  }
}

function applyVisitor(draft: Draft, now: IsoUtcInstant, rng: Rng, tuning: WorldTuning): void {
  const cause: EffectCause = { kind: 'deadline', deadlineKind: 'visitor_arrival' }
  const present = draft.world.environment.visitorId
  if (present !== null) {
    draft.world = {
      ...draft.world,
      environment: { ...draft.world.environment, visitorId: null },
      deadlines: replaceDeadline(
        draft.world.deadlines,
        scheduleDeadline('visitor_arrival', addMillis(now, tuning.visitor.intervalMs)),
      ),
    }
    record(draft, {
      type: 'visitor_left',
      at: now,
      variantId: null,
      from: present,
      to: 'alone',
      cause: 'deadline',
      sceneKey: null,
    })
    return
  }
  const variant = selectVariant(
    VISITOR_VARIANTS,
    contextOf(draft.world),
    draft.world.variation,
    rng,
  )
  if (variant !== null) {
    draft.world = {
      ...draft.world,
      environment: { ...draft.world.environment, visitorId: variant.visitorId },
    }
    const sceneKey = stage(draft, cause, variant.ambienceId, variant.variantId, now, tuning)
    record(draft, {
      type: 'visitor_arrived',
      at: now,
      variantId: variant.variantId,
      from: null,
      to: variant.visitorId,
      cause: 'deadline',
      sceneKey,
    })
  }
  draft.world = {
    ...draft.world,
    deadlines: replaceDeadline(
      draft.world.deadlines,
      scheduleDeadline(
        'visitor_arrival',
        addMillis(now, variant === null ? tuning.visitor.intervalMs : tuning.visitor.stayMs),
      ),
    ),
  }
}

function applyDeadline(
  draft: Draft,
  deadline: ScheduledDeadline,
  now: IsoUtcInstant,
  rng: Rng,
  tuning: WorldTuning,
): void {
  // A fired timer leaves the pending set first; each handler then schedules its
  // own successor. Without this a rescheduled kind with a different key (the
  // chapter beats) would leave the spent timer behind and fire it again. The
  // reference check keeps the paid fallback timer — which lives in the audit
  // state, not here — from touching the world (spec §8.5).
  const remaining = removeDeadline(draft.world.deadlines, deadline.kind, deadline.key)
  if (remaining !== draft.world.deadlines) {
    draft.world = { ...draft.world, deadlines: remaining }
  }

  switch (deadline.kind) {
    case 'idle_beat':
      applyIdleBeat(draft, now, rng, tuning)
      return
    case 'need_decay':
      applyNeedDecay(draft, now, rng, tuning)
      return
    case 'mission_close':
      refreshCreature(draft, now, rng, tuning, 'deadline', {
        kind: 'deadline',
        deadlineKind: 'mission_close',
      })
      resolveMission(draft, now, rng, tuning, 'deadline')
      return
    case 'choice_close':
      applyChoiceClose(draft, now, rng, tuning)
      return
    case 'world_phase':
      applyWorldPhase(draft, now, rng, tuning)
      return
    case 'weather_change':
      applyWeatherChange(draft, now, rng, tuning)
      return
    case 'visitor_arrival':
      applyVisitor(draft, now, rng, tuning)
      return
    case 'chapter_beat': {
      const beat: ChapterBeat =
        deadline.key === 'turn' ? 'turn' : deadline.key === 'resolution' ? 'resolution' : 'setup'
      playChapterBeat(draft, beat, now, rng, tuning)
      return
    }
    case 'crisis_recovery': {
      refreshCreature(draft, now, rng, tuning, 'deadline', {
        kind: 'deadline',
        deadlineKind: 'crisis_recovery',
      })
      draft.world = {
        ...draft.world,
        deadlines:
          draft.world.creature.crisis === null
            ? removeDeadline(draft.world.deadlines, 'crisis_recovery')
            : replaceDeadline(
                draft.world.deadlines,
                scheduleDeadline(
                  'crisis_recovery',
                  addMillis(now, tuning.crisis.recoveryIntervalMs),
                ),
              ),
      }
      return
    }
    case 'paid_thanks_fallback': {
      if (deadline.key === null) return
      const result = applyThanksFallback(draft.audit, deadline.key, now, tuning)
      draft.audit = result.audit
      draft.effects.push(...result.effects)
      draft.transitions.push(...result.transitions)
      return
    }
    default: {
      // Exhaustiveness: a new deadline kind fails to compile until it is handled.
      const unreachable: never = deadline.kind
      throw new Error(`unhandled deadline kind: ${String(unreachable)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface InitialWorldOptions {
  readonly seed: string
  readonly startedAt: IsoUtcInstant
  /** BOARD A-1: closed in V1. `true` enables the A/B/C vote path of spec §6.4. */
  readonly identityGateOpen?: boolean
  readonly creatureId?: Identifier
  readonly tuning?: WorldTuning
}

/**
 * A cold-start world. Every recurring timer is scheduled here, so a freshly
 * booted world already has content coming with no viewer input (spec §2.1).
 */
export function initialWorldState(options: InitialWorldOptions): WorldState {
  const tuning = options.tuning ?? DEFAULT_WORLD_TUNING
  const now = options.startedAt
  const rng = createRng(`${options.seed}#init`)
  const chapterId =
    rng.pickWeighted(CHAPTER_DEFINITIONS, (it) => it.weight)?.chapterId ?? 'gathering'
  const weather = rng.pick(WEATHER_VARIANTS)?.weatherId ?? 'clear'

  const world: GameState = {
    seed: options.seed,
    stepIndex: 0,
    worldTimeUtc: now,
    identity: { gateOpen: options.identityGateOpen ?? false },
    creature: {
      creatureId: options.creatureId ?? 'creature_1',
      growthStageIndex: 0,
      needs: { hungry: 0.2, play: 0.2, affection: 0.2, rest: 0.1 },
      needsUpdatedAt: now,
      emotionId: 'content',
      bond: { current: 0, target: tuning.growth.bondTarget },
      growth: { current: 0, target: growthTargetFor(0, tuning) },
      crisis: null,
      crisisSince: null,
    },
    environment: {
      environmentId: 'home_room',
      worldPhaseId: worldPhaseAt(now),
      weatherId: weather,
      visitorId: null,
    },
    chapter: {
      chapterId,
      dayIndex: 0,
      startedAt: now,
      endsAt: chapterEndFor(now, tuning),
      beat: 'setup',
      beatsPlayed: [],
      branchChoiceId: null,
      resolved: false,
    },
    mission: {
      missionId: 'quiet_company',
      variantId: 'mission_quiet_company',
      progress: { current: 0, target: tuning.mission.targetContributions },
      startedAt: now,
      closesAt: addMillis(now, tuning.mission.durationMs),
      contributions: {},
    },
    choice: null,
    variation: { recentVariantIds: [], recentSceneKeys: [] },
    lastAppliedAction: null,
    deadlines: [
      scheduleDeadline('idle_beat', addMillis(now, tuning.idleBeat.minIntervalMs)),
      scheduleDeadline('need_decay', addMillis(now, tuning.needs.decayIntervalMs)),
      scheduleDeadline('mission_close', addMillis(now, tuning.mission.durationMs)),
      scheduleDeadline('world_phase', nextWorldPhaseAt(now)),
      scheduleDeadline('weather_change', addMillis(now, tuning.weather.intervalMs)),
      scheduleDeadline('visitor_arrival', addMillis(now, tuning.visitor.intervalMs)),
      // Due immediately: the opening beat of the first chapter is the first thing
      // the world plays (spec §6.2 "시작").
      scheduleDeadline('chapter_beat', now, 'setup'),
    ],
  }

  return { world, audit: { pendingThanks: [], acknowledgedEventKeys: [] } }
}

/** Stable identity of an input, folded into the per-step RNG seed. */
export function inputKeyOf(input: StepInput): string {
  return input.kind === 'event'
    ? `event:${input.event.eventKey}`
    : `deadline:${input.deadline.kind}:${input.deadline.key ?? ''}:${input.deadline.dueAt}`
}

/**
 * Convenience for the engine: the generator for this step, derived from the
 * world seed, the step counter and the input identity. Replaying the same inbox
 * against the same seed therefore draws the same numbers without persisting a
 * generator cursor.
 */
export function stepRngFor(state: WorldState, input: StepInput): Rng {
  return createRng(`${state.world.seed}#${String(state.world.stepIndex)}#${inputKeyOf(input)}`)
}

/**
 * The reducer. Pure: same (state, input, now, rng) in, same result out, no I/O.
 */
export function step(
  state: WorldState,
  input: StepInput,
  now: IsoUtcInstant,
  rng: Rng,
  options: StepOptions = {},
): StepResult {
  const tuning = options.tuning ?? DEFAULT_WORLD_TUNING
  const draft: Draft = {
    world: state.world,
    audit: state.audit,
    transitions: [],
    effects: [],
    rejections: [],
  }

  if (input.kind === 'event') {
    const contributions = Math.min(
      MAX_CONTRIBUTIONS,
      Math.max(1, Math.trunc(input.contributions ?? 1)),
    )
    applyEvent(draft, input.event, contributions, now, rng, tuning)
  } else {
    applyDeadline(draft, input.deadline, now, rng, tuning)
  }

  // An input that moved nothing in the world — a paid acknowledgement, a refused
  // vote — leaves `world` referentially identical, so it cannot advance the step
  // counter or the world clock either, and therefore cannot shift a single later
  // random draw (spec §8.5). The engine still gets the audit state and effects.
  const world: GameState =
    draft.world === state.world
      ? draft.world
      : { ...draft.world, stepIndex: draft.world.stepIndex + 1, worldTimeUtc: now }
  const nextState: WorldState = { world, audit: draft.audit }
  return {
    state: nextState,
    transitions: draft.transitions,
    effects: draft.effects,
    deadlines: pendingDeadlines(nextState),
    rejections: draft.rejections,
  }
}

/**
 * Everything the engine must keep a timer for: the world's own schedule plus the
 * substitute-thanks obligations held in the audit state (spec §9.2, §10.2).
 */
export function pendingDeadlines(state: WorldState): readonly ScheduledDeadline[] {
  return [...state.world.deadlines, ...paidFallbackDeadlines(state.audit)]
}
