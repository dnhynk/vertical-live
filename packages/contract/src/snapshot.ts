import { z } from 'zod'

import { CommandNameSchema } from './commands.js'
import { BroadcastLifecycleSchema, InputModeSchema } from './enums.js'
import {
  IdentifierSchema,
  IsoUtcInstantSchema,
  ProgressSchema,
  TextKeySchema,
} from './primitives.js'
import { CONTRACT_VERSION } from './version.js'

/**
 * The authoritative world state the renderer reads (spec §6.3, §10.2). The
 * renderer owns no state: a refresh is recovered from a snapshot alone.
 *
 * Value vocabularies (life stage, need, weather, chapter, …) are identifiers
 * defined by the content director in T7. The contract fixes the shape only, so
 * this task does not invent content values.
 */

/** One branch offered in an open choice window (spec §6.2, §7.1). */
export const MissionChoiceSchema = z.strictObject({
  choiceId: IdentifierSchema,
  labelKey: TextKeySchema,
  /** Vote command that selects this branch, when a vote window is open. */
  commandName: CommandNameSchema.nullable(),
})
export type MissionChoice = z.infer<typeof MissionChoiceSchema>

/** Creature identity, stage, needs, emotion and progress (spec §6.3). */
export const CreatureStateSchema = z.strictObject({
  creatureId: IdentifierSchema,
  lifeStage: IdentifierSchema,
  growthStage: IdentifierSchema,
  needId: IdentifierSchema,
  emotionId: IdentifierSchema,
  bondProgress: ProgressSchema,
  growthProgress: ProgressSchema,
})
export type CreatureState = z.infer<typeof CreatureStateSchema>

/** Active mission and its choices (spec §6.3). */
export const MissionStateSchema = z.strictObject({
  missionId: IdentifierSchema,
  progress: ProgressSchema,
  choices: z.array(MissionChoiceSchema).max(8),
  /** Absolute close time of the choice window, `null` when none is open. */
  choiceClosesAt: IsoUtcInstantSchema.nullable(),
})
export type MissionState = z.infer<typeof MissionStateSchema>

/** Environment, world time of day, weather and chapter (spec §6.3). */
export const EnvironmentStateSchema = z.strictObject({
  environmentId: IdentifierSchema,
  worldPhaseId: IdentifierSchema,
  weatherId: IdentifierSchema,
  chapterId: IdentifierSchema,
  chapterProgress: ProgressSchema,
})
export type EnvironmentState = z.infer<typeof EnvironmentStateSchema>

/** Season and the persistent results of the previous one (spec §6.3, optional). */
export const SeasonStateSchema = z.strictObject({
  seasonId: IdentifierSchema,
  previousSeasonMementoIds: z.array(IdentifierSchema).max(32),
})
export type SeasonState = z.infer<typeof SeasonStateSchema>

/**
 * Non-competitive tally window (spec §6.4). While it is open the screen shows
 * the mode, the remaining time (derived from the absolute `endsAt`) and the
 * tallies. Counts are anonymous: per-user fairness is not claimed while the
 * identity gate is closed (BOARD A-1).
 */
export const AggregateWindowSchema = z.strictObject({
  mode: InputModeSchema,
  endsAt: IsoUtcInstantSchema,
  tallies: z
    .array(z.strictObject({ commandName: CommandNameSchema, count: z.int().nonnegative() }))
    .max(16),
})
export type AggregateWindow = z.infer<typeof AggregateWindowSchema>

/**
 * The four fixed slots of the 5-second silent-comprehension requirement
 * (spec §5.2). Text is carried as i18n keys, never as sentences, so raw chat
 * cannot reach the screen through the snapshot (spec §12.3).
 */
export const DisplayStateSchema = z.strictObject({
  currentNeedOrMission: z.strictObject({
    textKey: TextKeySchema,
    iconId: IdentifierSchema,
  }),
  lastAppliedAction: z
    .strictObject({
      commandName: CommandNameSchema,
      appliedAt: IsoUtcInstantSchema,
      contributionCount: z.int().positive(),
    })
    .nullable(),
  growthOrChapterProgress: z.strictObject({
    textKey: TextKeySchema,
    progress: ProgressSchema,
  }),
  nextChoiceAt: IsoUtcInstantSchema.nullable(),
  aggregateWindow: AggregateWindowSchema.optional(),
})
export type DisplayState = z.infer<typeof DisplayStateSchema>

export const WorldSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_VERSION),
  stateRevision: z.int().nonnegative(),
  processedIngestSeq: z.int().nonnegative(),
  worldTimeUtc: IsoUtcInstantSchema,
  inputMode: InputModeSchema,
  /** False disables the on-screen CTA while input or renderer ACK is unhealthy (spec §9.2). */
  interactionEnabled: z.boolean(),
  /**
   * Consent mode (BOARD D-9), which the renderer must not decide for itself.
   *
   * While the gate is closed the parser refuses `JOIN` and `LEAVE`
   * (`consent_disabled`), so a screen that still invites them is inviting a
   * command the server will reject — measured on the public broadcast of
   * 2026-08-29, where the notice was on air the whole time the parser was
   * refusing both spellings.
   *
   * Optional because snapshots written before this field existed do not carry
   * it. Absent is read as closed, which is both the safe direction and the state
   * every one of those builds was actually in.
   */
  identityGateOpen: z.boolean().optional(),
  broadcastLifecycle: BroadcastLifecycleSchema,
  creature: CreatureStateSchema,
  mission: MissionStateSchema.nullable(),
  environment: EnvironmentStateSchema,
  /** Absolute time of the next state transition (spec §6.3, §10.2). */
  nextTransitionAt: IsoUtcInstantSchema,
  season: SeasonStateSchema.optional(),
  display: DisplayStateSchema,
})
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>
