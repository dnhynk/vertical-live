import { z } from 'zod'

import { CommandRefSchema, ConsentCommandRefSchema } from './commands.js'
import { EventKindSchema, EventSourceSchema, SourceShapeSchema } from './enums.js'
import { ExternalIdSchema, IsoUtcInstantSchema } from './primitives.js'
import { CONTRACT_VERSION } from './version.js'

/**
 * The append-only ingest inbox record (spec §7.3(1)(2)).
 *
 * Every API item produces exactly one envelope, including items we do not
 * support and items that fail validation. The envelope has no field for an
 * author, a display name, a channel id or the raw message text, so those values
 * cannot be persisted even by mistake — not even for a consented viewer, whose
 * name is stored once in the consent record T20b owns and nowhere else
 * (spec §7.4, §12.4; BOARD A-1, D-9).
 */

/**
 * Closed set of rejection reasons. There is deliberately no free-text message:
 * a source string in an error would be a hole in the "no raw text" rule.
 */
export const ValidationErrorCodeSchema = z.enum([
  'MALFORMED_ITEM',
  'MISSING_MESSAGE_ID',
  'MALFORMED_MESSAGE_ID',
  'MISSING_SNIPPET',
  'MISSING_MESSAGE_TYPE',
  'UNSUPPORTED_MESSAGE_TYPE',
  'LIVE_CHAT_ID_MISMATCH',
  'MISSING_PUBLISHED_AT',
  'MALFORMED_PUBLISHED_AT',
  'MISSING_EVENT_DETAILS',
  'MALFORMED_AMOUNT',
  'MALFORMED_TIER',
  'MALFORMED_JEWELS',
  'MALFORMED_COMBO_COUNT',
])
export type ValidationErrorCode = z.infer<typeof ValidationErrorCodeSchema>

export const ValidationErrorSchema = z.strictObject({
  code: ValidationErrorCodeSchema,
  /** Dotted path of the offending source field, e.g. `snippet.published_at`. */
  field: z
    .string()
    .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, 'field must be a dotted source field path')
    .nullable(),
  /**
   * The platform message type we could not handle, kept for operations metrics
   * (T12). It is an API enum token, never user content.
   */
  sourceMessageType: z
    .string()
    .regex(/^[A-Za-z_]{1,64}$/, 'source message type must be an API enum token')
    .nullable(),
})
export type ValidationError = z.infer<typeof ValidationErrorSchema>

/**
 * Structured paid fields (spec §7.4). Amounts, tiers and jewel counts are read
 * from the API and never guessed from a string (spec §7.2). They buy audit,
 * staging and identity only — never game power (spec §8.5).
 */
export const PaymentDetailsSchema = z.strictObject({
  amountMicros: z.int().nonnegative().nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 alphabetic code')
    .nullable(),
  tier: z.int().positive().nullable(),
  jewels: z.int().nonnegative().nullable(),
  comboCount: z.int().nonnegative().nullable(),
  /** Gift catalogue name from `gift_details` / `giftMetadata` (BOARD A-8). */
  giftName: z
    .string()
    .regex(/^[A-Za-z0-9 _-]{1,64}$/, 'gift name must be a short catalogue token')
    .nullable(),
})
export type PaymentDetails = z.infer<typeof PaymentDetailsSchema>

const ingestEnvelopeBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
  sourceShape: SourceShapeSchema,
  source: EventSourceSchema,
  broadcastId: ExternalIdSchema,
  liveChatId: ExternalIdSchema,
  receivedAt: IsoUtcInstantSchema,
}

/** A supported, well-formed item. Only this variant carries normalized fields. */
export const ValidIngestEnvelopeSchema = z.strictObject({
  ...ingestEnvelopeBase,
  messageId: ExternalIdSchema,
  validationStatus: z.literal('valid'),
  kind: EventKindSchema,
  occurredAt: IsoUtcInstantSchema,
  /** Present only for a recognized free command; `null` otherwise. */
  command: CommandRefSchema.nullable(),
  /**
   * Present only for a recognized consent command (BOARD D-9); `null` or absent
   * otherwise. It is kept apart from `command` because a consent decision moves
   * no world state: nothing that feeds growth, tallies or staging reads this
   * field, and nothing that reads `command` can see a `JOIN` (TASK_SPECS §T20a).
   *
   * The envelope still carries no identity of its own. The inbox is an
   * append-only table (T4) and D-9 requires `LEAVE` to delete a consent record
   * immediately, so the display name and the channel reference live only in the
   * consent store T20b owns — the row here records that a decision arrived, not
   * whose it was.
   */
  consentCommand: ConsentCommandRefSchema.nullable().optional(),
  /** Present only for paid events; `null` otherwise. */
  payment: PaymentDetailsSchema.nullable(),
})
export type ValidIngestEnvelope = z.infer<typeof ValidIngestEnvelopeSchema>

/**
 * An unsupported or malformed item. It still becomes an inbox row so the
 * checkpoint can advance past it with a recorded reason (spec §7.3(2)(3)).
 * `messageId` is nullable because a malformed item may not carry one — we
 * record the gap instead of inventing an id.
 */
export const RejectedIngestEnvelopeSchema = z.strictObject({
  ...ingestEnvelopeBase,
  messageId: ExternalIdSchema.nullable(),
  validationStatus: z.enum(['unsupported', 'invalid']),
  validationError: ValidationErrorSchema,
})
export type RejectedIngestEnvelope = z.infer<typeof RejectedIngestEnvelopeSchema>

export const IngestEnvelopeSchema = z.discriminatedUnion('validationStatus', [
  ValidIngestEnvelopeSchema,
  RejectedIngestEnvelopeSchema,
])
export type IngestEnvelope = z.infer<typeof IngestEnvelopeSchema>
