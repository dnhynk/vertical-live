import type { CommandParser } from '../commands.js'
import type { EventKind, SourceShape } from '../enums.js'
import {
  IngestEnvelopeSchema,
  type IngestEnvelope,
  type PaymentDetails,
  type ValidationErrorCode,
} from '../ingest.js'
import { CONTRACT_VERSION } from '../version.js'

/**
 * Assembly rules shared by the gRPC and REST source adapters.
 *
 * Field *names* live in the shape-specific readers ([S4] proto snake_case in
 * `grpc.ts`, [S3] REST camelCase in `rest.ts`) and are never mixed. This module
 * only owns the policy that is identical for both: what an envelope may contain,
 * and that raw text is handed to the command parser instead of being stored
 * (spec §7.3(1)).
 */

export interface IngestAdapterContext {
  /** Broadcast the listener is attached to; chat items do not carry it. */
  readonly broadcastId: string
  /** Chat the listener subscribed to. Items claiming another chat are rejected. */
  readonly liveChatId: string
  /** Wall-clock receive time from the caller's injected `Clock`, UTC ISO 8601. */
  readonly receivedAt: string
  /**
   * Command parser injected by the caller (implemented in T6). Only free chat
   * text is offered to it: paid comments are never parsed into commands, because
   * payment must not buy input (spec §8.5).
   */
  readonly parseCommand: CommandParser
}

/** Everything a reader must extract before an envelope can be assembled. */
export interface NormalizedItemFacts {
  readonly messageId: string
  readonly kind: EventKind
  /** Canonical UTC instant derived from the platform publish time. */
  readonly occurredAt: string
  /** Raw text of a free chat message, offered to the parser and then dropped. */
  readonly commandText: string | null
  readonly payment: PaymentDetails | null
}

export interface RejectionFacts {
  readonly status: 'unsupported' | 'invalid'
  readonly messageId: string | null
  readonly code: ValidationErrorCode
  readonly field: string | null
  readonly sourceMessageType: string | null
}

/** Payment object with every field nulled; readers fill in what their shape has. */
export const EMPTY_PAYMENT: PaymentDetails = {
  amountMicros: null,
  currency: null,
  tier: null,
  jewels: null,
  comboCount: null,
  giftName: null,
}

/**
 * Outcome of reading one numeric source field.
 *
 * The three cases are kept apart on purpose: an absent field is normal (the
 * §7.4 payment contract makes every number nullable), while a field that is
 * present but outside the contract is a malformed item. Collapsing the two
 * would either invent a value or throw inside `IngestEnvelopeSchema.parse`,
 * and spec §7.3(1) requires a minimal envelope for a malformed item instead.
 */
export type IntegerRead =
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly value: number }
  | { readonly status: 'malformed' }

const ABSENT: IntegerRead = { status: 'absent' }
const MALFORMED: IntegerRead = { status: 'malformed' }

/**
 * Reads an integer API field in either its JSON number or JSON string encoding
 * ([S3] reports `unsigned long` as a string, gRPC depends on the loader's
 * `longs` option), and holds it to the same bound the schema does — so a value
 * that reaches `buildValidEnvelope` can never fail validation there.
 */
export function readInteger(
  container: Record<string, unknown>,
  key: string,
  minimum: number,
): IntegerRead {
  const value = container[key]
  if (value === undefined || value === null || value === '') return ABSENT
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= minimum ? { status: 'ok', value } : MALFORMED
  }
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    return parsed >= minimum ? { status: 'ok', value: parsed } : MALFORMED
  }
  return MALFORMED
}

/** ISO 4217 alphabetic code, upper-cased. */
export function toCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const upper = value.toUpperCase()
  return /^[A-Z]{3}$/.test(upper) ? upper : null
}

/** Gift catalogue name, kept only when it is a short safe token (BOARD A-8). */
export function toGiftName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^[A-Za-z0-9 _-]{1,64}$/.test(value) ? value : null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a string field, treating empty strings as absent (proto3/JSON defaults). */
export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function buildValidEnvelope(
  facts: NormalizedItemFacts,
  ctx: IngestAdapterContext,
  sourceShape: SourceShape,
): IngestEnvelope {
  const command = facts.commandText === null ? null : ctx.parseCommand(facts.commandText)
  return IngestEnvelopeSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    messageId: facts.messageId,
    sourceShape,
    source: 'youtube',
    broadcastId: ctx.broadcastId,
    liveChatId: ctx.liveChatId,
    receivedAt: ctx.receivedAt,
    validationStatus: 'valid',
    kind: facts.kind,
    occurredAt: facts.occurredAt,
    command,
    payment: facts.payment,
  })
}

export function buildRejectedEnvelope(
  facts: RejectionFacts,
  ctx: IngestAdapterContext,
  sourceShape: SourceShape,
): IngestEnvelope {
  return IngestEnvelopeSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    messageId: facts.messageId,
    sourceShape,
    source: 'youtube',
    broadcastId: ctx.broadcastId,
    liveChatId: ctx.liveChatId,
    receivedAt: ctx.receivedAt,
    validationStatus: facts.status,
    validationError: {
      code: facts.code,
      field: facts.field,
      sourceMessageType: facts.sourceMessageType,
    },
  })
}
