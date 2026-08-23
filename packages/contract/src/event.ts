import { z } from 'zod'

import { CommandRefSchema } from './commands.js'
import { EventKindSchema, EventSourceSchema } from './enums.js'
import { ActorSchema } from './identity.js'
import { PaymentDetailsSchema, type ValidIngestEnvelope } from './ingest.js'
import {
  EXTERNAL_ID_CHARS,
  ExternalIdSchema,
  IsoUtcInstantSchema,
  type IsoUtcInstant,
} from './primitives.js'
import { CONTRACT_VERSION } from './version.js'

/**
 * The canonical event contract of spec §7.4, field for field.
 *
 * `actor` is `null` by default and can only ever be the consented shape of
 * BOARD D-9 instead: a viewer who opted in with `JOIN` carries a display name
 * and an opaque `channelRef`, everyone else carries nothing. The raw channel id
 * has no field here at all, so identity cannot be stored by mistake
 * (spec §7.4, §12.4; see `identity.ts`).
 */

/**
 * Largest gift count the contract can carry, and the one bound the key spelling
 * is derived from.
 *
 * `PaymentDetailsSchema.comboCount` is a `z.int()`, which accepts exactly the
 * JavaScript safe integers (the generated JSON Schema shows it as
 * `maximum: 9007199254740991`), and both adapters normalize to the same range.
 * Spec §7.4 fixes no ceiling of its own, so none is invented here: the key
 * pattern and the value check below are both computed from this constant, and a
 * count that an envelope can hold can therefore always be spelled in a key.
 */
export const MAX_GIFT_EFFECTIVE_COUNT = Number.MAX_SAFE_INTEGER

/**
 * `youtube:{broadcastId}:{messageId}`, with the `:gift:{effectiveCount}` suffix
 * for gift events (spec §7.4).
 */
const EVENT_KEY_PATTERN = new RegExp(
  `^(youtube|simulator):([${EXTERNAL_ID_CHARS}]{1,128}):([${EXTERNAL_ID_CHARS}]{1,128})` +
    `(?::gift:([1-9][0-9]{0,${String(MAX_GIFT_EFFECTIVE_COUNT).length - 1}}))?$`,
)

export const EventKeySchema = z
  .string()
  .regex(
    EVENT_KEY_PATTERN,
    'event key must be {source}:{broadcastId}:{messageId}[:gift:{effectiveCount}]',
  )
  // The pattern bounds the suffix by digit count; this bounds it by value, so a
  // key can never name a count no `PaymentDetailsSchema.comboCount` could hold.
  .refine((key) => (parseEventKey(key)?.effectiveCount ?? 0) <= MAX_GIFT_EFFECTIVE_COUNT, {
    error: `gift effectiveCount must not exceed ${String(MAX_GIFT_EFFECTIVE_COUNT)}`,
  })
export type EventKey = z.infer<typeof EventKeySchema>

interface ParsedEventKey {
  readonly source: string
  readonly broadcastId: string
  readonly messageId: string
  /** Present only on a gift key; `null` on every other event. */
  readonly effectiveCount: number | null
}

function parseEventKey(eventKey: string): ParsedEventKey | null {
  const match = EVENT_KEY_PATTERN.exec(eventKey)
  if (match === null) return null
  const [, source, broadcastId, messageId, effectiveCount] = match
  return {
    source: source as string,
    broadcastId: broadcastId as string,
    messageId: messageId as string,
    effectiveCount: effectiveCount === undefined ? null : Number(effectiveCount),
  }
}

const canonicalEventShape = z.strictObject({
  schemaVersion: z.literal(CONTRACT_VERSION),
  eventKey: EventKeySchema,
  ingestSeq: z.int().positive(),
  source: EventSourceSchema,
  broadcastId: ExternalIdSchema,
  liveChatId: ExternalIdSchema,
  kind: EventKindSchema,
  occurredAt: IsoUtcInstantSchema,
  receivedAt: IsoUtcInstantSchema,
  /** `null` unless the viewer consented (BOARD D-9); never a raw channel id. */
  actor: ActorSchema,
  command: CommandRefSchema.nullable(),
  payment: PaymentDetailsSchema.nullable(),
  /**
   * Absolute deletion deadline for the source-derived data of this row. Spec
   * §7.4 writes `"policy-limited"` in its example; TASK_SPECS §T1 fixes the
   * representation as an ISO UTC instant computed from the retention constant.
   */
  sourceDataExpiresAt: IsoUtcInstantSchema,
})

/**
 * The §7.4 key rule is a relation, not just a shape: the key restates the
 * event's own `source` and `broadcastId`, and the `:gift:{effectiveCount}`
 * suffix exists exactly for gift events. Without these checks a well-formed key
 * could name another broadcast or another source, or a non-gift event could
 * carry a combo suffix — and the key is the idempotency unit the inbox, the
 * paid ledger and the effect outbox all deduplicate on (spec §7.3(2)(4)).
 *
 * JSON Schema draft 2020-12 cannot express an equality between two properties,
 * so `schema/canonical-event.schema.json` still only carries the key pattern.
 * The zod schema is the source of truth (CLAUDE.md §4) and is what the server
 * validates with.
 */
export const CanonicalEventSchema = canonicalEventShape
  .refine((event) => parseEventKey(event.eventKey)?.source === event.source, {
    path: ['eventKey'],
    error: 'eventKey source segment must equal source',
  })
  .refine((event) => parseEventKey(event.eventKey)?.broadcastId === event.broadcastId, {
    path: ['eventKey'],
    error: 'eventKey broadcast segment must equal broadcastId',
  })
  .refine(
    (event) => (parseEventKey(event.eventKey)?.effectiveCount !== null) === (event.kind === 'GIFT'),
    {
      path: ['eventKey'],
      error: 'only a GIFT event may carry the :gift:{effectiveCount} suffix, and it must carry one',
    },
  )
  .refine(
    (event) => {
      const effectiveCount = parseEventKey(event.eventKey)?.effectiveCount
      if (effectiveCount === null || effectiveCount === undefined) return true
      // §7.4 defines the effective count for *every* gift, including one that
      // reports no combo count: `comboCount > 0 ? comboCount : 1`. A missing
      // count is therefore the first gift and admits exactly `:gift:1`. Leaving
      // that case unchecked would let a gift with no reported count carry any
      // suffix at all, which is the idempotency unit the inbox and the paid
      // ledger deduplicate on. This is the same expression `eventKeyForEnvelope`
      // builds the key from, so a helper-produced key always satisfies it.
      return effectiveCount === effectiveGiftCount(event.payment?.comboCount ?? null)
    },
    {
      path: ['eventKey'],
      error: 'gift eventKey suffix must equal effectiveCount = comboCount > 0 ? comboCount : 1',
    },
  )
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
export function giftEventKeyFor(
  parts: EventKeyParts & { readonly comboCount: number | null },
): EventKey {
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
