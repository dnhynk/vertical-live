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
 * REST `liveChatMessages.list` fallback adapter.
 *
 * Field names come from the liveChatMessages resource reference [S3] (checked
 * 2026-08-16) and are camelCase throughout. This file must never read a gRPC
 * (snake_case) name; `grpc.ts` is the mirror image (spec §7.2).
 *
 * `snippet.authorChannelId` and the `authorDetails` part are deliberately never
 * read: while the identity gate is closed we request only `id,snippet` and store
 * no identity at all (spec §7.2, §7.4).
 */

interface TypeBinding {
  readonly kind: EventKind
  /** `snippet` member that carries this type's payload. */
  readonly detailsField: string
  /** Nested member inside `detailsField`, when the resource has one ([S3] gift). */
  readonly metadataField?: string
}

/** Types V1 consumes (spec §7.2, TASK_SPECS §T1). Everything else is `unsupported`. */
const SUPPORTED_TYPES: Readonly<Record<string, TypeBinding>> = {
  textMessageEvent: { kind: 'CHAT_COMMAND', detailsField: 'textMessageDetails' },
  superChatEvent: { kind: 'SUPER_CHAT', detailsField: 'superChatDetails' },
  superStickerEvent: { kind: 'SUPER_STICKER', detailsField: 'superStickerDetails' },
  giftEvent: { kind: 'GIFT', detailsField: 'giftEventDetails', metadataField: 'giftMetadata' },
  newSponsorEvent: { kind: 'MEMBERSHIP', detailsField: 'newSponsorDetails' },
  memberMilestoneChatEvent: { kind: 'MEMBERSHIP', detailsField: 'memberMilestoneChatDetails' },
  membershipGiftingEvent: { kind: 'MEMBERSHIP', detailsField: 'membershipGiftingDetails' },
  giftMembershipReceivedEvent: {
    kind: 'MEMBERSHIP',
    detailsField: 'giftMembershipReceivedDetails',
  },
}

/** Turns one `liveChatMessage` resource from a `list` response into an envelope. */
export function fromRestListItem(item: unknown, ctx: IngestAdapterContext): IngestEnvelope {
  const reject = (
    code: ValidationErrorCode,
    field: string | null,
    messageId: string | null,
    sourceMessageType: string | null = null,
    status: 'unsupported' | 'invalid' = 'invalid',
  ): IngestEnvelope =>
    buildRejectedEnvelope({ status, messageId, code, field, sourceMessageType }, ctx, 'rest')

  if (!isRecord(item)) return reject('MALFORMED_ITEM', null, null)

  const messageId = readString(item, 'id')
  if (messageId === null) return reject('MISSING_MESSAGE_ID', 'id', null)
  // An id outside the external-id charset cannot be stored in either envelope
  // variant, and a `:` in it would forge an `eventKey` separator (spec §7.4),
  // so the envelope records the gap instead of the offending value.
  if (!EXTERNAL_ID_PATTERN.test(messageId)) return reject('MALFORMED_MESSAGE_ID', 'id', null)

  const snippet = item['snippet']
  if (!isRecord(snippet)) return reject('MISSING_SNIPPET', 'snippet', messageId)

  const typeToken = readString(snippet, 'type')
  if (typeToken === null || !/^[A-Za-z_]{1,64}$/.test(typeToken)) {
    return reject('MISSING_MESSAGE_TYPE', 'snippet.type', messageId)
  }

  const binding = SUPPORTED_TYPES[typeToken]
  if (binding === undefined) {
    return reject('UNSUPPORTED_MESSAGE_TYPE', 'snippet.type', messageId, typeToken, 'unsupported')
  }

  const itemLiveChatId = readString(snippet, 'liveChatId')
  if (itemLiveChatId !== null && itemLiveChatId !== ctx.liveChatId) {
    return reject('LIVE_CHAT_ID_MISMATCH', 'snippet.liveChatId', messageId, typeToken)
  }

  const publishedAt = snippet['publishedAt']
  if (publishedAt === undefined || publishedAt === null) {
    return reject('MISSING_PUBLISHED_AT', 'snippet.publishedAt', messageId, typeToken)
  }
  const occurredAt = toIsoUtcInstant(publishedAt)
  if (occurredAt === null) {
    return reject('MALFORMED_PUBLISHED_AT', 'snippet.publishedAt', messageId, typeToken)
  }

  const outer = snippet[binding.detailsField]
  if (!isRecord(outer)) {
    return reject('MISSING_EVENT_DETAILS', `snippet.${binding.detailsField}`, messageId, typeToken)
  }
  let details = outer
  let detailsPath = `snippet.${binding.detailsField}`
  if (binding.metadataField !== undefined) {
    const nested = outer[binding.metadataField]
    detailsPath = `${detailsPath}.${binding.metadataField}`
    if (!isRecord(nested)) {
      return reject('MISSING_EVENT_DETAILS', detailsPath, messageId, typeToken)
    }
    details = nested
  }

  let commandText: string | null = null
  let payment: PaymentDetails | null = null

  switch (binding.kind) {
    case 'CHAT_COMMAND': {
      // Only free chat text reaches the parser; it is dropped right after.
      commandText = readString(details, 'messageText')
      break
    }
    case 'SUPER_CHAT':
    case 'SUPER_STICKER': {
      // `userComment` exists on super chats and is deliberately not read:
      // a paid comment must not be able to buy a command (spec §8.5).
      const amountMicros = readInteger(details, 'amountMicros', 0)
      if (amountMicros.status !== 'ok') {
        return reject('MALFORMED_AMOUNT', `${detailsPath}.amountMicros`, messageId, typeToken)
      }
      // `tier` is optional in the contract, so only a present-but-out-of-range
      // value is an error; 0 and negatives are not tiers ([S3] tier is 1-based).
      const tier = readInteger(details, 'tier', 1)
      if (tier.status === 'malformed') {
        return reject('MALFORMED_TIER', `${detailsPath}.tier`, messageId, typeToken)
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
      const jewels = readInteger(details, 'jewelsAmount', 0)
      if (jewels.status === 'malformed') {
        return reject('MALFORMED_JEWELS', `${detailsPath}.jewelsAmount`, messageId, typeToken)
      }
      // A non-combo gift reports no combo count and counts as the first one
      // (spec §7.4), so an absent value normalizes to 0 rather than rejecting.
      const comboCount = readInteger(details, 'comboCount', 0)
      if (comboCount.status === 'malformed') {
        return reject('MALFORMED_COMBO_COUNT', `${detailsPath}.comboCount`, messageId, typeToken)
      }
      payment = {
        ...EMPTY_PAYMENT,
        jewels: jewels.status === 'ok' ? jewels.value : null,
        comboCount: comboCount.status === 'ok' ? comboCount.value : 0,
        giftName: toGiftName(details['giftName']),
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
    { messageId, kind: binding.kind, occurredAt, commandText, payment },
    ctx,
    'rest',
  )
}
