import { z } from 'zod'

import { CommandNameSchema } from './commands.js'
import { EventKeySchema } from './event.js'
import { IdentifierSchema, IsoUtcInstantSchema } from './primitives.js'
import { CONTRACT_VERSION } from './version.js'

/**
 * A staged, idempotent piece of presentation (spec §7.3(6), §10.2).
 *
 * Paid effects are the durable outbox rows: they carry the causing event key and
 * absolute start/end times so a restart replays them exactly once and the
 * renderer can ignore an `effectId` it has already applied (spec §7.3(7)).
 * No payload field can name a person, and none of them change game outcomes
 * (spec §8.4, §8.5).
 */

export const EffectIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'effect id must be 1-128 chars of [A-Za-z0-9_-]')
export type EffectId = z.infer<typeof EffectIdSchema>

/** Which paid event a thanks effect acknowledges. */
export const PaidEventKindSchema = z.enum(['SUPER_CHAT', 'SUPER_STICKER', 'GIFT', 'MEMBERSHIP'])
export type PaidEventKind = z.infer<typeof PaidEventKindSchema>

const effectBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
  effectId: EffectIdSchema,
  causedByEventKey: EventKeySchema,
  stateRevision: z.int().nonnegative(),
  startsAt: IsoUtcInstantSchema,
  endsAt: IsoUtcInstantSchema,
  paid: z.boolean(),
}

/** Reaction to free commands. `contributionCount` preserves aggregated input (spec §7.3). */
export const ActionReactionEffectSchema = z.strictObject({
  ...effectBase,
  kind: z.literal('ACTION_REACTION'),
  paid: z.literal(false),
  payload: z.strictObject({
    commandName: CommandNameSchema,
    contributionCount: z.int().positive(),
  }),
})

/**
 * Pre-described fixed thanks animation for a paid event (spec §8.4). `fallback`
 * marks the substitute run after a degraded window expired (spec §9.2); it has
 * the same shape and no game power.
 */
export const PaidThanksEffectSchema = z.strictObject({
  ...effectBase,
  kind: z.literal('PAID_THANKS'),
  paid: z.literal(true),
  payload: z.strictObject({
    paidEventKind: PaidEventKindSchema,
    /** Anonymous icon shown instead of a supporter name (spec §12.3 default). */
    iconId: IdentifierSchema,
    tier: z.int().positive().nullable(),
    fallback: z.boolean(),
  }),
})

/** Room-wide staging: seasonal background, lighting, music (spec §8.4). */
export const AmbienceEffectSchema = z.strictObject({
  ...effectBase,
  kind: z.literal('AMBIENCE'),
  payload: z.strictObject({
    ambienceId: IdentifierSchema,
  }),
})

/** Mission start / progress / completion beat (spec §6.2). */
export const MissionUpdateEffectSchema = z.strictObject({
  ...effectBase,
  kind: z.literal('MISSION_UPDATE'),
  paid: z.literal(false),
  payload: z.strictObject({
    missionId: IdentifierSchema,
    phase: z.enum(['STARTED', 'PROGRESS', 'COMPLETED']),
  }),
})

export const EffectSchema = z.discriminatedUnion('kind', [
  ActionReactionEffectSchema,
  PaidThanksEffectSchema,
  AmbienceEffectSchema,
  MissionUpdateEffectSchema,
])
export type Effect = z.infer<typeof EffectSchema>
export type EffectKind = Effect['kind']
