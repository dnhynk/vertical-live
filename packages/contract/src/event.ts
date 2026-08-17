import { z } from 'zod'

import { CommandRefSchema } from './commands.js'
import { EventKindSchema, EventSourceSchema } from './enums.js'
import { PaymentDetailsSchema, type ValidIngestEnvelope } from './ingest.js'
import { ExternalIdSchema, IsoUtcInstantSchema, type IsoUtcInstant } from './primitives.js'
import { CONTRACT_VERSION } from './version.js'

/**
 * The canonical event contract of spec §7.4, field for field.
 *
 * `actor` is typed as `null`: while the identity feature gate is closed there is
 * no approved schema extension for a user, so the type system — not a runtime
 * check — guarantees no identity is stored (spec §7.4, §12.4, BOARD A-1).
 */

/**
 * `youtube:{broadcastId}:{messageId}`, with the `:gift:{effectiveCount}` suffix
 * for gift events (spec §7.4).
 */
export const EventKeySchema = z
  .string()
  .regex(
    /^(youtube|simulator):[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}(:gift:[1-9][0-9]{0,8})?$/,
    'event key must be {source}:{broadcastId}:{messageId}[:gift:{effectiveCount}]',
  )
export type EventKey = z.infer<typeof EventKeySchema>

export const CanonicalEventSchema = z.strictObject({
  schemaVersion: z.literal(CONTRACT_VERSION),
  eventKey: EventKeySchema,
  ingestSeq: z.int().positive(),
  source: EventSourceSchema,
  broadcastId: ExternalIdSchema,
  liveChatId: ExternalIdSchema,
  kind: EventKindSchema,
  occurredAt: IsoUtcInstantSchema,
  receivedAt: IsoUtcInstantSchema,
  actor: z.null(),
  command: CommandRefSchema.nullable(),
  payment: PaymentDetailsSchema.nullable(),
  /**
   * Absolute deletion deadline for the source-derived data of this row. Spec
   * §7.4 writes `"policy-limited"` in its example; TASK_SPECS §T1 fixes the
   * representation as an ISO UTC instant computed from the retention constant.
   */
  sourceDataExpiresAt: IsoUtcInstantSchema,
})
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>

/**
 * Default retention for general Authorized/Non-Authorized API Data (spec §12.4,
 * BOARD A-7). Per-field schedules land in T13; this is the fallback ceiling.
 */
export const SOURCE_DATA_RETENTION_DAYS = 30

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000

/** `receivedAt + SOURCE_DATA_RETENTION_DAYS`, as an absolute UTC instant. */
export function sourceDataExpiresAt(
  receivedAt: IsoUtcInstant,
  retentionDays: number = SOURCE_DATA_RETENTION_DAYS,
): IsoUtcInstant {
  const received = Date.parse(receivedAt)
  if (Number.isNaN(received)) throw new TypeError(`receivedAt is not an instant: ${receivedAt}`)
  return new Date(received + retentionDays * MILLIS_PER_DAY).toISOString()
}

/**
 * `effectiveCount = comboCount > 0 ? comboCount : 1` (spec §7.4). A non-combo
 * gift reports `comboCount = 0` and still counts as the first one.
 */
export function effectiveGiftCount(comboCount: number | null | undefined): number {
  if (typeof comboCount !== 'number' || !Number.isFinite(comboCount)) return 1
  return comboCount > 0 ? Math.trunc(comboCount) : 1
}

export interface EventKeyParts {
  readonly source: z.infer<typeof EventSourceSchema>
  readonly broadcastId: string
  readonly messageId: string
}

/** Event key for every non-gift event. */
export function eventKeyFor(parts: EventKeyParts): EventKey {
  return `${parts.source}:${parts.broadcastId}:${parts.messageId}`
}

/**
 * Event key for a gift event. YouTube reuses the same message id to report a
 * growing combo ([S4] `LiveChatMessage.id`), so the effective count is part of
 * the key: each combo step is its own idempotency unit and `delta` against the
 * stored maximum is computed by the state engine in T8.
 */
export function giftEventKeyFor(parts: EventKeyParts & { readonly comboCount: number | null }): EventKey {
  return `${eventKeyFor(parts)}:gift:${effectiveGiftCount(parts.comboCount)}`
}

/** Picks the right key rule for an already-validated envelope. */
export function eventKeyForEnvelope(envelope: ValidIngestEnvelope): EventKey {
  const parts: EventKeyParts = {
    source: envelope.source,
    broadcastId: envelope.broadcastId,
    messageId: envelope.messageId,
  }
  if (envelope.kind === 'GIFT') {
    return giftEventKeyFor({ ...parts, comboCount: envelope.payment?.comboCount ?? null })
  }
  return eventKeyFor(parts)
}
