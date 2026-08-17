import type { CommandRef } from '../commands.js'
import type { EventKind } from '../enums.js'
import type { IngestEnvelope, PaymentDetails, ValidationErrorCode } from '../ingest.js'
import { EXTERNAL_ID_PATTERN, toIsoUtcInstant } from '../primitives.js'
import {
  EMPTY_PAYMENT,
  buildRejectedEnvelope,
  buildValidEnvelope,
  isRecord,
  readInteger,
  readString,
  toCurrency,
  toGiftName,
  type IngestAdapterContext,
} from './shared.js'

/**
 * gRPC `streamList` source adapter.
 *
 * Field names come from the inline proto of the Streaming Live Chat guide [S4]
 * (`V3DataLiveChatMessageService.StreamList`, checked 2026-08-16) and are
 * snake_case throughout. This file must never read a REST (camelCase) name;
 * `rest.ts` is the mirror image (spec §7.2 "gRPC proto와 REST resource의 필드명을
 * 섞지 않고").
 *
 * The caller is expected to load the proto with `keepCase: true` (field names as
 * written in the proto) and `enums: String`; numeric enum values are accepted
 * too, so a loader configured with `enums: Number` still works.
 *
 * `snippet.author_channel_id` and `author_details` are present on the wire and
 * are deliberately never read: while the identity gate is closed we request only
 * the `id,snippet` parts and store no identity at all (spec §7.2, §7.4).
 */

/** `LiveChatMessageSnippet.TypeWrapper.Type` values from the proto [S4]. */
const TYPE_NAME_BY_NUMBER: Readonly<Record<number, string>> = {
  0: 'INVALID_TYPE',
  1: 'TEXT_MESSAGE_EVENT',
  2: 'TOMBSTONE',
  3: 'FAN_FUNDING_EVENT',
  4: 'CHAT_ENDED_EVENT',
  5: 'SPONSOR_ONLY_MODE_STARTED_EVENT',
  6: 'SPONSOR_ONLY_MODE_ENDED_EVENT',
  7: 'NEW_SPONSOR_EVENT',
  10: 'USER_BANNED_EVENT',
  15: 'SUPER_CHAT_EVENT',
  16: 'SUPER_STICKER_EVENT',
  17: 'MEMBER_MILESTONE_CHAT_EVENT',
  18: 'MEMBERSHIP_GIFTING_EVENT',
  19: 'GIFT_MEMBERSHIP_RECEIVED_EVENT',
  20: 'POLL_EVENT',
  21: 'GIFT_EVENT',
}

interface TypeBinding {
  readonly kind: EventKind
  /** `oneof displayed_content` member that carries this type's payload. */
  readonly detailsField: string
}

/** Types V1 consumes (spec §7.2, TASK_SPECS §T1). Everything else is `unsupported`. */
const SUPPORTED_TYPES: Readonly<Record<string, TypeBinding>> = {
  TEXT_MESSAGE_EVENT: { kind: 'CHAT_COMMAND', detailsField: 'text_message_details' },
  SUPER_CHAT_EVENT: { kind: 'SUPER_CHAT', detailsField: 'super_chat_details' },
  SUPER_STICKER_EVENT: { kind: 'SUPER_STICKER', detailsField: 'super_sticker_details' },
  GIFT_EVENT: { kind: 'GIFT', detailsField: 'gift_details' },
  NEW_SPONSOR_EVENT: { kind: 'MEMBERSHIP', detailsField: 'new_sponsor_details' },
  MEMBER_MILESTONE_CHAT_EVENT: {
    kind: 'MEMBERSHIP',
    detailsField: 'member_milestone_chat_details',
  },
  MEMBERSHIP_GIFTING_EVENT: { kind: 'MEMBERSHIP', detailsField: 'membership_gifting_details' },
  GIFT_MEMBERSHIP_RECEIVED_EVENT: {
    kind: 'MEMBERSHIP',
    detailsField: 'gift_membership_received_details',
  },
}

function readTypeToken(snippet: Record<string, unknown>): string | null {
  const raw = snippet['type']
  if (typeof raw === 'string' && /^[A-Za-z_]{1,64}$/.test(raw)) return raw
  if (typeof raw === 'number') return TYPE_NAME_BY_NUMBER[raw] ?? null
  return null
}

/** Turns one `LiveChatMessage` from `LiveChatMessageListResponse.items` into an envelope. */
export function fromGrpcStreamListItem(item: unknown, ctx: IngestAdapterContext): IngestEnvelope {
  const reject = (
    code: ValidationErrorCode,
    field: string | null,
    messageId: string | null,
    sourceMessageType: string | null = null,
    status: 'unsupported' | 'invalid' = 'invalid',
  ): IngestEnvelope =>
    buildRejectedEnvelope({ status, messageId, code, field, sourceMessageType }, ctx, 'grpc')

  if (!isRecord(item)) return reject('MALFORMED_ITEM', null, null)

  const messageId = readString(item, 'id')
  if (messageId === null) return reject('MISSING_MESSAGE_ID', 'id', null)
  // An id outside the external-id charset cannot be stored in either envelope
  // variant, and a `:` in it would forge an `eventKey` separator (spec §7.4),
  // so the envelope records the gap instead of the offending value.
  if (!EXTERNAL_ID_PATTERN.test(messageId)) return reject('MALFORMED_MESSAGE_ID', 'id', null)

  const snippet = item['snippet']
  if (!isRecord(snippet)) return reject('MISSING_SNIPPET', 'snippet', messageId)

  const typeToken = readTypeToken(snippet)
  if (typeToken === null) return reject('MISSING_MESSAGE_TYPE', 'snippet.type', messageId)

  const binding = SUPPORTED_TYPES[typeToken]
  if (binding === undefined) {
    return reject('UNSUPPORTED_MESSAGE_TYPE', 'snippet.type', messageId, typeToken, 'unsupported')
  }

  const itemLiveChatId = readString(snippet, 'live_chat_id')
  if (itemLiveChatId !== null && itemLiveChatId !== ctx.liveChatId) {
    return reject('LIVE_CHAT_ID_MISMATCH', 'snippet.live_chat_id', messageId, typeToken)
  }

  const publishedAt = snippet['published_at']
  if (publishedAt === undefined || publishedAt === null) {
    return reject('MISSING_PUBLISHED_AT', 'snippet.published_at', messageId, typeToken)
  }
  const occurredAt = toIsoUtcInstant(publishedAt)
  if (occurredAt === null) {
    return reject('MALFORMED_PUBLISHED_AT', 'snippet.published_at', messageId, typeToken)
  }

  const details = snippet[binding.detailsField]
  if (!isRecord(details)) {
    return reject('MISSING_EVENT_DETAILS', `snippet.${binding.detailsField}`, messageId, typeToken)
  }

  let command: CommandRef | null = null
  let payment: PaymentDetails | null = null

  switch (binding.kind) {
    case 'CHAT_COMMAND': {
      // Free chat text is read, parsed and dropped inside this block: it is
      // never carried further, not even in a TypeScript-only assembly field.
      const text = readString(details, 'message_text')
      command = text === null ? null : ctx.parseCommand(text)
      break
    }
    case 'SUPER_CHAT':
    case 'SUPER_STICKER': {
      // `user_comment` exists on super chats and is deliberately not read:
      // a paid comment must not be able to buy a command (spec §8.5).
      const amountMicros = readInteger(details, 'amount_micros', 0)
      if (amountMicros.status !== 'ok') {
        return reject(
          'MALFORMED_AMOUNT',
          `snippet.${binding.detailsField}.amount_micros`,
          messageId,
          typeToken,
        )
      }
      // `tier` is optional in the contract, so only a present-but-out-of-range
      // value is an error; 0 and negatives are not tiers ([S3] tier is 1-based).
      const tier = readInteger(details, 'tier', 1)
      if (tier.status === 'malformed') {
        return reject(
          'MALFORMED_TIER',
          `snippet.${binding.detailsField}.tier`,
          messageId,
          typeToken,
        )
      }
      payment = {
        ...EMPTY_PAYMENT,
        amountMicros: amountMicros.value,
        currency: toCurrency(details['currency']),
        tier: tier.status === 'ok' ? tier.value : null,
      }
      break
    }
    case 'GIFT': {
      const jewels = readInteger(details, 'jewels_amount', 0)
      if (jewels.status === 'malformed') {
        return reject(
          'MALFORMED_JEWELS',
          `snippet.${binding.detailsField}.jewels_amount`,
          messageId,
          typeToken,
        )
      }
      // A non-combo gift reports no combo count and counts as the first one
      // (spec §7.4), so an absent value normalizes to 0 rather than rejecting.
      const comboCount = readInteger(details, 'combo_count', 0)
      if (comboCount.status === 'malformed') {
        return reject(
          'MALFORMED_COMBO_COUNT',
          `snippet.${binding.detailsField}.combo_count`,
          messageId,
          typeToken,
        )
      }
      payment = {
        ...EMPTY_PAYMENT,
        jewels: jewels.status === 'ok' ? jewels.value : null,
        comboCount: comboCount.status === 'ok' ? comboCount.value : 0,
        giftName: toGiftName(details['gift_name']),
      }
      break
    }
    case 'MEMBERSHIP': {
      // Membership level names and gift counts have no field in the §7.4
      // payment contract, so they are not carried into the envelope.
      break
    }
    case 'SYSTEM': {
      break
    }
  }

  return buildValidEnvelope(
    { messageId, kind: binding.kind, occurredAt, command, payment },
    ctx,
    'grpc',
  )
}
