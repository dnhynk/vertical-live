import { z } from 'zod'

import { CommandNameSchema } from './commands.js'
import { EventKeySchema, type EventKey } from './event.js'
import { ActorSchema } from './identity.js'
import { IdentifierSchema, IsoUtcInstantSchema } from './primitives.js'
import { CONTRACT_VERSION } from './version.js'

/**
 * A staged, idempotent piece of presentation (spec §7.3(6), §10.2).
 *
 * Only the free action reaction can name a viewer, and only a consented one
 * (BOARD D-9). The paid thanks animation stays anonymous by construction — it
 * has no `actor` field at all — because spending must not buy a name on screen
 * (spec §8.4, §8.5).
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

/**
 * Row id of the deadline that fired, issued by the persistence layer
 * (`deadlines.id`, T4). Same character class as `effectId`: it is a stored
 * identifier, not text, and excluding `:` keeps it from spelling an `eventKey`.
 */
export const DeadlineIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'deadline id must be 1-128 chars of [A-Za-z0-9_-]')
export type DeadlineId = z.infer<typeof DeadlineIdSchema>

/** Which paid event a thanks effect acknowledges. */
export const PaidEventKindSchema = z.enum(['SUPER_CHAT', 'SUPER_STICKER', 'GIFT', 'MEMBERSHIP'])
export type PaidEventKind = z.infer<typeof PaidEventKindSchema>

/** An ingested event caused this effect; the key is the idempotency unit (spec §7.3(6)). */
export const EventCauseSchema = z.strictObject({
  kind: z.literal('event'),
  eventKey: EventKeySchema,
})

/**
 * A world deadline caused this effect. Spec §2.1 and §6.2 require content to
 * keep moving with zero viewers, so the seconds-scale staging of a timer has no
 * event to point at; `deadlineKind` is the content-defined kind that carries the
 * `replay|coalesce|skip` policy of spec §10.2 (T7 defines the vocabulary), and
 * `deadlineId` names the individual row when the engine has one.
 */
export const DeadlineCauseSchema = z.strictObject({
  kind: z.literal('deadline'),
  deadlineKind: IdentifierSchema,
  deadlineId: DeadlineIdSchema.optional(),
})

export const EffectCauseSchema = z.discriminatedUnion('kind', [
  EventCauseSchema,
  DeadlineCauseSchema,
])
export type EffectCause = z.infer<typeof EffectCauseSchema>

const effectBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
  effectId: EffectIdSchema,
  cause: EffectCauseSchema,
  /**
   * The event key spec §7.3(6) and §10.2 name by hand, kept as its own field so
   * the WS message and the outbox row still expose it directly. It restates
   * `cause.eventKey` and is `null` exactly when a deadline caused the effect —
   * the refinements below make the two representations unable to disagree.
   */
  causedByEventKey: EventKeySchema.nullable(),
  stateRevision: z.int().nonnegative(),
  startsAt: IsoUtcInstantSchema,
  endsAt: IsoUtcInstantSchema,
  paid: z.boolean(),
}

interface CausedEffect {
  readonly cause: EffectCause
  readonly causedByEventKey: EventKey | null
  readonly paid: boolean
}

/**
 * The two cause rules of BOARD A-17, applied to every variant rather than to the
 * union, so validating with an exported variant schema (`PaidThanksEffectSchema`
 * and friends, which T8 assembles against) enforces exactly what
 * `EffectSchema.parse` does.
 *
 * JSON Schema draft 2020-12 cannot express a relation between two properties, so
 * `schema/effect.schema.json` only carries the shapes; the zod schema is the
 * source of truth and is what the server validates with (CLAUDE.md §4).
 */
function withCauseRules<T extends z.ZodType<CausedEffect>>(schema: T): T {
  return schema
    .refine(
      (effect) =>
        effect.cause.kind === 'event'
          ? effect.causedByEventKey === effect.cause.eventKey
          : effect.causedByEventKey === null,
      {
        path: ['causedByEventKey'],
        error:
          'causedByEventKey must equal cause.eventKey for an event cause and be null for a deadline cause',
      },
    )
    .refine((effect) => !effect.paid || effect.cause.kind === 'event', {
      path: ['cause'],
      // A paid effect is a durable audit row and spec §10.2 requires it to store
      // the causing event key; a timer never owes anyone thanks (spec §8.4).
      error: 'a paid effect must be caused by an event, not by a deadline',
    })
}

/**
 * Reaction to free commands. `contributionCount` preserves aggregated input
 * (spec §7.3). An aggregate window is closed by its timer, so this variant also
 * occurs with a deadline cause (spec §6.4).
 *
 * This is the one effect that can name a person, and only a consented one
 * (BOARD D-9): the display name reaches the screen through the "just applied
 * action" slot (spec §5.2(2), T20c) and nowhere else. The field is optional so
 * every effect written before D-9 stays valid and anonymous; absent and `null`
 * mean the same thing.
 */
export const ActionReactionEffectSchema = withCauseRules(
  z.strictObject({
    ...effectBase,
    kind: z.literal('ACTION_REACTION'),
    paid: z.literal(false),
    /** Consented viewer whose command produced this reaction, if any. */
    actor: ActorSchema.optional(),
    payload: z.strictObject({
      commandName: CommandNameSchema,
      contributionCount: z.int().positive(),
    }),
  }),
).refine((effect) => (effect.actor ?? null) === null || effect.payload.contributionCount === 1, {
  path: ['actor'],
  // An aggregated reaction stands for several viewers (spec §6.4, §7.3), so
  // attaching one name to it would credit one of them with everyone else's
  // input — a participation claim that is not true (spec §2.6).
  error: 'an aggregated reaction must not name an actor',
})

/**
 * Pre-described fixed thanks animation for a paid event (spec §8.4). `fallback`
 * marks the substitute run after a degraded window expired (spec §9.2); it has
 * the same shape and no game power.
 */
export const PaidThanksEffectSchema = withCauseRules(
  z.strictObject({
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
  }),
)

/**
 * Room-wide staging: seasonal background, lighting, music (spec §8.4). Either a
 * paid event or the world clock can open one, which is why `paid` stays a
 * boolean here and the paid rule is a refinement rather than a literal.
 */
export const AmbienceEffectSchema = withCauseRules(
  z.strictObject({
    ...effectBase,
    kind: z.literal('AMBIENCE'),
    payload: z.strictObject({
      ambienceId: IdentifierSchema,
    }),
  }),
)

/** Mission start / progress / completion beat (spec §6.2). */
export const MissionUpdateEffectSchema = withCauseRules(
  z.strictObject({
    ...effectBase,
    kind: z.literal('MISSION_UPDATE'),
    paid: z.literal(false),
    payload: z.strictObject({
      missionId: IdentifierSchema,
      phase: z.enum(['STARTED', 'PROGRESS', 'COMPLETED']),
    }),
  }),
)

export const EffectSchema = z.discriminatedUnion('kind', [
  ActionReactionEffectSchema,
  PaidThanksEffectSchema,
  AmbienceEffectSchema,
  MissionUpdateEffectSchema,
])
export type Effect = z.infer<typeof EffectSchema>
export type EffectKind = Effect['kind']
