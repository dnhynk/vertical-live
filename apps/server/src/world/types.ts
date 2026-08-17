import type {
  CanonicalEvent,
  CommandName,
  DeadlinePolicy,
  EventKey,
  Identifier,
  IsoUtcInstant,
  PaidEventKind,
  Progress,
  TextKey,
} from '@vl/contract'

/**
 * Vocabulary and state shape of the content director (spec §6.2, §6.3).
 *
 * Everything here is data: the reducer in `reducer.ts` is pure and does no I/O,
 * so the state below is the only thing that carries the world between steps. The
 * `@vl/contract` identifiers are re-used for the values the renderer reads, and
 * `project.ts` narrows this state into the contract's `WorldSnapshot` fields.
 *
 * No field can hold an author, a display name or a chat line: the world speaks in
 * identifiers and i18n keys only (spec §7.4, §12.3, BOARD A-1).
 */

/** Which §6.2 time scale a piece of content belongs to. */
export const TIME_SCALES = ['seconds', 'minutes', 'hours', 'day'] as const
export type TimeScale = (typeof TIME_SCALES)[number]

/**
 * Needs the creature accumulates pressure on. `hungry`/`play`/`affection` are the
 * three free commands of spec §7.1; `rest` has no command and is relieved by time
 * alone, which is what makes `sleeping` a recoverable crisis (spec §6.3).
 */
export const NEED_IDS = ['hungry', 'play', 'affection', 'rest'] as const
export type NeedId = (typeof NEED_IDS)[number]

/**
 * The three recoverable crisis states named by spec §6.3. There is deliberately
 * no death, no permanent regression and no paid-only recovery state: the type
 * itself cannot express one.
 */
export const CRISIS_IDS = ['sleeping', 'tired', 'needs_help'] as const
export type CrisisId = (typeof CRISIS_IDS)[number]

export const EMOTION_IDS = [
  'joyful',
  'content',
  'curious',
  'lonely',
  'sleepy',
  'weary',
  'worried',
] as const
export type EmotionId = (typeof EMOTION_IDS)[number]

/**
 * Ordered growth ladder. Every step is reachable with free participation alone
 * (spec §2.3): only free commands, missions and elapsed time add growth, and the
 * index never decreases (spec §6.3).
 */
export const GROWTH_STAGES = ['egg', 'hatchling', 'fledgling', 'companion', 'guardian'] as const
export type GrowthStage = (typeof GROWTH_STAGES)[number]

/** Coarse life stage shown on screen; derived from the growth stage. */
export const LIFE_STAGES = ['egg', 'child', 'youth', 'adult'] as const
export type LifeStage = (typeof LIFE_STAGES)[number]

export const ENVIRONMENT_IDS = ['home_room', 'garden', 'riverside', 'night_terrace'] as const
export type EnvironmentId = (typeof ENVIRONMENT_IDS)[number]

/** Time of day in JST, the broadcast's time base (spec §5.3). */
export const WORLD_PHASE_IDS = ['dawn', 'morning', 'afternoon', 'evening', 'night'] as const
export type WorldPhaseId = (typeof WORLD_PHASE_IDS)[number]

export const WEATHER_IDS = ['clear', 'cloudy', 'rain', 'wind', 'starry'] as const
export type WeatherId = (typeof WEATHER_IDS)[number]

export const VISITOR_IDS = ['postal_bird', 'lantern_moth', 'garden_cat', 'wandering_tinker'] as const
export type VisitorId = (typeof VISITOR_IDS)[number]

export const MISSION_IDS = [
  'share_a_meal',
  'chase_the_ribbon',
  'quiet_company',
  'gather_ingredients',
  'hang_the_lanterns',
] as const
export type MissionId = (typeof MISSION_IDS)[number]

/** Daily chapters (spec §6.2 "하루" row: 재료 찾기 / 축제 준비 / 성장·진화 선택). */
export const CHAPTER_IDS = ['gathering', 'festival_prep', 'growth_choice'] as const
export type ChapterId = (typeof CHAPTER_IDS)[number]

/** A daily chapter always runs start → change → end (spec §6.2, §12.5). */
export const CHAPTER_BEATS = ['setup', 'turn', 'resolution'] as const
export type ChapterBeat = (typeof CHAPTER_BEATS)[number]

/** Vote commands, i.e. the branch commands of spec §7.1. */
export const VOTE_COMMANDS = ['VOTE_A', 'VOTE_B', 'VOTE_C'] as const
export type VoteCommand = (typeof VOTE_COMMANDS)[number]

/** Free care commands, i.e. the non-branch commands of spec §7.1. */
export const CARE_COMMANDS = ['FEED', 'PLAY', 'PET'] as const
export type CareCommand = (typeof CARE_COMMANDS)[number]

// ---------------------------------------------------------------------------
// Deadlines (spec §10.2)
// ---------------------------------------------------------------------------

/**
 * Every timer the world can schedule. The list is a tuple so the runtime value
 * and the type stay one source: `DEADLINE_DEFINITIONS` must cover exactly these
 * keys or it does not compile (see `deadlines.ts`).
 */
export const DEADLINE_KINDS = [
  'idle_beat',
  'need_decay',
  'mission_close',
  'choice_close',
  'world_phase',
  'weather_change',
  'visitor_arrival',
  'chapter_beat',
  'crisis_recovery',
  'paid_thanks_fallback',
] as const
export type DeadlineKind = (typeof DEADLINE_KINDS)[number]

/**
 * The content definition of one deadline kind. Spec §10.2 requires each kind to
 * carry exactly one downtime policy, so `policy` is a required field here and the
 * table that fills it is exhaustive by type.
 */
export interface DeadlineDefinition {
  readonly kind: DeadlineKind
  readonly policy: DeadlinePolicy
  readonly scale: TimeScale
  /** Why this policy is the right one after downtime. Kept next to the value. */
  readonly rationale: string
}

/**
 * Every deadline kind mapped to its policy. Omitting a kind is a compile error,
 * which is the mechanism behind TASK_SPECS §T7 acceptance 4.
 */
export type DeadlinePolicyMap = Record<DeadlineKind, DeadlinePolicy>

/**
 * A scheduled timer. `policy` is copied from the definition table by
 * `scheduleDeadline()`, which is the only constructor, so a deadline without a
 * policy cannot be built (spec §10.2, TASK_SPECS §T7 acceptance 4).
 */
export interface ScheduledDeadline {
  readonly kind: DeadlineKind
  readonly dueAt: IsoUtcInstant
  /** Discriminates several pending timers of one kind, e.g. one paid event key. */
  readonly key: string | null
  readonly policy: DeadlinePolicy
}

// ---------------------------------------------------------------------------
// Effects (drafts — the engine assembles the contract `Effect`)
// ---------------------------------------------------------------------------

/**
 * Why an effect exists. Timer-driven staging has no causing event, and the
 * contract's `Effect.causedByEventKey` is non-nullable, so the reducer returns a
 * draft with an explicit cause and T8 assembles `effectId`, `stateRevision` and
 * `causedByEventKey` when it writes the outbox row (coordinator answer to the T7
 * question, 2026-08-17; contract follow-up T1b promotes this discriminator).
 */
export type EffectCause =
  | { readonly kind: 'event'; readonly eventKey: EventKey }
  | { readonly kind: 'deadline'; readonly deadlineKind: DeadlineKind; readonly deadlineId?: string }

/** Cause of an effect that must be traceable to a real event (paid audit). */
export type EventCause = Extract<EffectCause, { kind: 'event' }>

interface EffectDraftBase {
  readonly startsAt: IsoUtcInstant
  readonly endsAt: IsoUtcInstant
  readonly cause: EffectCause
  /** Variant that produced this staging, for the §12.5 repeat metrics. */
  readonly variantId: Identifier | null
}

/** Reaction to free commands; `contributionCount` preserves aggregation (§7.3). */
export interface ActionReactionDraft extends EffectDraftBase {
  readonly kind: 'ACTION_REACTION'
  readonly paid: false
  readonly cause: EventCause
  readonly payload: {
    readonly commandName: CommandName
    readonly contributionCount: number
  }
}

/**
 * Fixed, pre-described thanks staging for a paid event (spec §8.4). `cause` is
 * narrowed to `EventCause`: a paid acknowledgement always names the paid event it
 * acknowledges, so a timer can never fabricate one. `fallback` marks the single
 * substitute run of spec §9.2.
 */
export interface PaidThanksDraft extends EffectDraftBase {
  readonly kind: 'PAID_THANKS'
  readonly paid: true
  readonly cause: EventCause
  readonly payload: {
    readonly paidEventKind: PaidEventKind
    readonly iconId: Identifier
    readonly tier: number | null
    readonly fallback: boolean
  }
}

/** Room-wide staging: weather, time of day, visitors, idle beats (spec §8.4). */
export interface AmbienceDraft extends EffectDraftBase {
  readonly kind: 'AMBIENCE'
  readonly paid: false
  readonly payload: { readonly ambienceId: Identifier }
}

/** Mission start / progress / completion beat (spec §6.2). */
export interface MissionUpdateDraft extends EffectDraftBase {
  readonly kind: 'MISSION_UPDATE'
  readonly paid: false
  readonly payload: {
    readonly missionId: Identifier
    readonly phase: 'STARTED' | 'PROGRESS' | 'COMPLETED'
  }
}

export type EffectDraft = ActionReactionDraft | PaidThanksDraft | AmbienceDraft | MissionUpdateDraft

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export const TRANSITION_TYPES = [
  'idle_beat',
  'need_relieved',
  'need_pressure',
  'emotion_changed',
  'crisis_entered',
  'crisis_recovered',
  'bond_progress',
  'growth_progress',
  'growth_stage_advanced',
  'mission_started',
  'mission_progress',
  'mission_resolved',
  'choice_opened',
  'choice_resolved',
  'chapter_started',
  'chapter_beat',
  'chapter_resolved',
  'weather_changed',
  'phase_changed',
  'visitor_arrived',
  'visitor_left',
  'paid_acknowledged',
] as const
export type TransitionType = (typeof TRANSITION_TYPES)[number]

/**
 * Which §6.2 time scale each transition belongs to. The map is exhaustive by
 * type, so a new transition type has to declare its scale — that is what lets
 * the tests assert that a zero-input day produced content on all four scales
 * (spec §6.2, the Gate 3 requirement).
 */
export const TRANSITION_SCALES = {
  idle_beat: 'seconds',
  need_relieved: 'minutes',
  need_pressure: 'minutes',
  emotion_changed: 'minutes',
  crisis_entered: 'minutes',
  crisis_recovered: 'minutes',
  bond_progress: 'minutes',
  growth_progress: 'minutes',
  growth_stage_advanced: 'day',
  mission_started: 'minutes',
  mission_progress: 'minutes',
  mission_resolved: 'minutes',
  choice_opened: 'day',
  choice_resolved: 'day',
  chapter_started: 'day',
  chapter_beat: 'day',
  chapter_resolved: 'day',
  weather_changed: 'hours',
  phase_changed: 'hours',
  visitor_arrived: 'hours',
  visitor_left: 'hours',
  paid_acknowledged: 'seconds',
} as const satisfies Record<TransitionType, TimeScale>

/**
 * One recorded state transition. This is the unit spec §14.1 "신선도" counts, so
 * it carries both the transition identity and the scene it staged (`sceneKey`,
 * `null` when the transition produced no scene).
 */
export interface WorldTransition {
  readonly type: TransitionType
  readonly at: IsoUtcInstant
  readonly variantId: Identifier | null
  readonly from: string | null
  readonly to: string
  readonly cause: 'command' | 'deadline' | 'paid' | 'director'
  readonly sceneKey: string | null
}

/** Why an input was not applied. Rejections change no state (spec §6.4, §7.1). */
export const REJECTION_REASONS = [
  'vote_disabled',
  'vote_window_closed',
  'unknown_choice',
  'not_a_world_input',
  'duplicate_paid_event',
] as const
export type RejectionReason = (typeof REJECTION_REASONS)[number]

export interface InputRejection {
  readonly reason: RejectionReason
  readonly eventKey: EventKey | null
  readonly at: IsoUtcInstant
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface CreatureDomainState {
  readonly creatureId: Identifier
  readonly growthStageIndex: number
  /** Pressure per need, 0 (satisfied) … 1 (at the ceiling). Never below 0. */
  readonly needs: Readonly<Record<NeedId, number>>
  /** Absolute time the pressures were last integrated, for time-based decay. */
  readonly needsUpdatedAt: IsoUtcInstant
  readonly emotionId: EmotionId
  readonly bond: Progress
  readonly growth: Progress
  readonly crisis: CrisisId | null
  readonly crisisSince: IsoUtcInstant | null
}

export interface EnvironmentDomainState {
  readonly environmentId: EnvironmentId
  readonly worldPhaseId: WorldPhaseId
  readonly weatherId: WeatherId
  readonly visitorId: VisitorId | null
}

export interface ChapterDomainState {
  readonly chapterId: ChapterId
  readonly dayIndex: number
  readonly startedAt: IsoUtcInstant
  readonly endsAt: IsoUtcInstant
  readonly beat: ChapterBeat
  readonly beatsPlayed: readonly ChapterBeat[]
  /** Branch the chapter took, once its choice resolved. */
  readonly branchChoiceId: Identifier | null
  /** True once the resolution beat has played (spec §6.2 "결말"). */
  readonly resolved: boolean
}

export interface MissionDomainState {
  readonly missionId: MissionId
  readonly variantId: Identifier
  readonly progress: Progress
  readonly startedAt: IsoUtcInstant
  readonly closesAt: IsoUtcInstant
  /** Total accepted contributions per command. Anonymous counts only (A-1). */
  readonly contributions: Readonly<Partial<Record<CareCommand, number>>>
}

export interface ChoiceOption {
  readonly choiceId: Identifier
  readonly labelKey: TextKey
  /**
   * Vote command that selects this branch. `null` while the identity gate is
   * closed: no per-user branch vote exists then (spec §6.4, BOARD A-9).
   */
  readonly commandName: VoteCommand | null
  /** Director rule this option belongs to, used by the gate-closed path. */
  readonly eventCombinationId: Identifier
}

/**
 * An open decision point. `mode` is fixed when the window opens from
 * `identity.gateOpen`, so both §6.4 paths exist in the same state shape.
 */
export interface ChoiceDomainState {
  /** The chapter whose branch this window decides (spec §6.2). */
  readonly choiceSetId: ChapterId
  readonly mode: 'vote' | 'director'
  readonly options: readonly ChoiceOption[]
  readonly opensAt: IsoUtcInstant
  readonly closesAt: IsoUtcInstant
  /** Per-option vote counts. Only ever non-zero in `vote` mode. */
  readonly voteTally: Readonly<Partial<Record<VoteCommand, number>>>
  /**
   * Non-competitive tally of free care commands during the window (spec §6.4).
   * It is a room total, never a per-user judgement, and no fairness per user is
   * claimed while the identity gate is closed.
   */
  readonly contributionTally: Readonly<Partial<Record<CareCommand, number>>>
}

export interface VariationState {
  /** Bounded ring of recently used variant ids, for §12.5 repeat avoidance. */
  readonly recentVariantIds: readonly Identifier[]
  /** Bounded ring of recently staged scene keys. */
  readonly recentSceneKeys: readonly string[]
}

export interface LastAppliedAction {
  readonly commandName: CommandName
  readonly appliedAt: IsoUtcInstant
  readonly contributionCount: number
}

/**
 * Everything that can affect an outcome: needs, growth, missions, choices,
 * chapters, environment, timers. Paid input can never produce a value of this
 * type — see `WorldState` and `paid.ts` (spec §8.5).
 */
export interface GameState {
  readonly seed: string
  /** Monotonic step counter; part of the per-step RNG derivation. */
  readonly stepIndex: number
  readonly worldTimeUtc: IsoUtcInstant
  /** BOARD A-1: closed in V1. Opening it enables the A/B/C vote path (§6.4). */
  readonly identity: { readonly gateOpen: boolean }
  readonly creature: CreatureDomainState
  readonly environment: EnvironmentDomainState
  readonly chapter: ChapterDomainState
  readonly mission: MissionDomainState
  readonly choice: ChoiceDomainState | null
  readonly variation: VariationState
  readonly lastAppliedAction: LastAppliedAction | null
  readonly deadlines: readonly ScheduledDeadline[]
}

/** A paid acknowledgement that has been staged but not confirmed on screen. */
export interface PendingThanks {
  readonly eventKey: EventKey
  readonly paidEventKind: PaidEventKind
  readonly tier: number | null
  readonly iconId: Identifier
  readonly stagedAt: IsoUtcInstant
  /** After this instant the original staging window is gone (spec §9.2). */
  readonly fallbackAt: IsoUtcInstant
}

/**
 * Paid bookkeeping only. Nothing here is read by the free-play rules, and the
 * paid handler cannot return anything else, which is how spec §8.5 ("payment
 * buys no game power") is enforced by the type system rather than by review.
 */
export interface AuditState {
  readonly pendingThanks: readonly PendingThanks[]
  /** Bounded ring guarding "exactly one" acknowledgement per paid event key. */
  readonly acknowledgedEventKeys: readonly EventKey[]
}

export interface WorldState {
  readonly world: GameState
  readonly audit: AuditState
}

// ---------------------------------------------------------------------------
// Reducer signature
// ---------------------------------------------------------------------------

export type StepInput =
  | {
      readonly kind: 'event'
      readonly event: CanonicalEvent
      /**
       * How many free contributions this event stands for. `1` in `direct` mode;
       * the arbiter (T6) collapses an aggregate window into one event and passes
       * the preserved count here (spec §6.4, §7.3). The canonical event carries
       * no count field, so it travels with the input instead.
       */
      readonly contributions?: number
    }
  | { readonly kind: 'deadline'; readonly deadline: ScheduledDeadline }

export interface StepResult {
  readonly state: WorldState
  readonly transitions: readonly WorldTransition[]
  readonly effects: readonly EffectDraft[]
  /** The full pending schedule after the step; the engine replaces its table. */
  readonly deadlines: readonly ScheduledDeadline[]
  /** Inputs the world refused. Empty on the success path. */
  readonly rejections: readonly InputRejection[]
}
