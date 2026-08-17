import { describe, expect, it } from 'vitest'

import { fromGrpcStreamListItem } from './adapters/grpc.js'
import { fromRestListItem } from './adapters/rest.js'
import type { IngestAdapterContext } from './adapters/shared.js'
import {
  CanonicalEventSchema,
  EventKeySchema,
  SOURCE_DATA_RETENTION_DAYS,
  effectiveGiftCount,
  eventKeyFor,
  eventKeyForEnvelope,
  giftEventKeyFor,
  sourceDataExpiresAt,
} from './event.js'
import { loadSourceFixture } from './fixtures/load.js'
import type { ValidIngestEnvelope } from './ingest.js'
import { CONTRACT_VERSION } from './version.js'

/**
 * Canonical event rules of spec §7.4 (TASK_SPECS §T1 acceptance 2 and 4).
 *
 * The gift rule matters because YouTube reuses one message id while a combo
 * grows ([S4] `LiveChatMessage.id`), so the effective count is what makes each
 * combo step its own idempotency unit.
 */

const BROADCAST_ID = 'bcast_test_0001'
const LIVE_CHAT_ID = 'chat_test_0001'
const RECEIVED_AT = '2026-08-16T00:10:00.000Z'

const ctx: IngestAdapterContext = {
  broadcastId: BROADCAST_ID,
  liveChatId: LIVE_CHAT_ID,
  receivedAt: RECEIVED_AT,
  parseCommand: () => null,
}

const ADAPTERS = { grpc: fromGrpcStreamListItem, rest: fromRestListItem }
const SHAPES = ['grpc', 'rest'] as const

function validEnvelope(shape: 'grpc' | 'rest', name: string): ValidIngestEnvelope {
  const envelope = ADAPTERS[shape](loadSourceFixture(shape, name).item, ctx)
  if (envelope.validationStatus !== 'valid') {
    throw new Error(`${shape}/${name} did not normalize to a valid envelope`)
  }
  return envelope
}

describe('effectiveGiftCount', () => {
  it('treats a non-combo gift (comboCount 0) as the first one', () => {
    expect(effectiveGiftCount(0)).toBe(1)
  })

  it.each([
    [1, 1],
    [3, 3],
    [5, 5],
    [1000, 1000],
  ])('passes a positive combo count through (%i → %i)', (input, expected) => {
    expect(effectiveGiftCount(input)).toBe(expected)
  })

  it.each([null, undefined, Number.NaN, -2])('falls back to 1 for %s', (input) => {
    expect(effectiveGiftCount(input as number | null | undefined)).toBe(1)
  })
})

describe('eventKey rules (spec §7.4)', () => {
  it('uses {source}:{broadcastId}:{messageId} for a non-gift event', () => {
    expect(eventKeyFor({ source: 'youtube', broadcastId: 'b_1', messageId: 'm_1' })).toBe(
      'youtube:b_1:m_1',
    )
  })

  it('appends :gift:{effectiveCount} for a gift event', () => {
    expect(
      giftEventKeyFor({ source: 'youtube', broadcastId: 'b_1', messageId: 'm_1', comboCount: 3 }),
    ).toBe('youtube:b_1:m_1:gift:3')
  })

  it('rejects a gift key with effectiveCount 0 — there is no zeroth gift', () => {
    expect(EventKeySchema.safeParse('youtube:b_1:m_1:gift:0').success).toBe(false)
  })

  it.each(SHAPES)(
    '%s gift fixtures 0/1/3/5 collapse to the effective-count keys 1/1/3/5',
    (shape) => {
      const keys = ['0', '1', '3', '5'].map((combo) =>
        eventKeyForEnvelope(validEnvelope(shape, `gift-event-combo-${combo}`)),
      )
      // combo 0 and combo 1 are the same first gift reported twice, so they share
      // one key; the state engine (T8) derives the delta from the stored maximum.
      expect(keys).toEqual([
        `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:1`,
        `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:1`,
        `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:3`,
        `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:5`,
      ])
      expect(new Set(keys).size).toBe(3)
      for (const key of keys) expect(EventKeySchema.safeParse(key).success).toBe(true)
    },
  )

  it.each(SHAPES)('%s non-gift fixtures get an unsuffixed key', (shape) => {
    expect(eventKeyForEnvelope(validEnvelope(shape, 'text-message-event'))).toBe(
      `youtube:${BROADCAST_ID}:msg_test_0001`,
    )
    expect(eventKeyForEnvelope(validEnvelope(shape, 'super-chat-event'))).toBe(
      `youtube:${BROADCAST_ID}:msg_test_0003`,
    )
  })

  it.each(SHAPES)('%s produces the same keys from both wire shapes', (shape) => {
    const other = shape === 'grpc' ? 'rest' : 'grpc'
    for (const name of ['text-message-event', 'gift-event-combo-3', 'new-sponsor-event']) {
      expect(eventKeyForEnvelope(validEnvelope(shape, name))).toBe(
        eventKeyForEnvelope(validEnvelope(other, name)),
      )
    }
  })

  it('rejects a key whose ids contain the separator', () => {
    expect(EventKeySchema.safeParse('youtube:b:1:m:1').success).toBe(false)
  })
})

describe('sourceDataExpiresAt', () => {
  it('is receivedAt + the retention constant, as an absolute UTC instant', () => {
    expect(SOURCE_DATA_RETENTION_DAYS).toBe(30)
    expect(sourceDataExpiresAt('2026-08-16T00:00:00.000Z')).toBe('2026-09-15T00:00:00.000Z')
  })

  it('accepts an explicit shorter retention', () => {
    expect(sourceDataExpiresAt('2026-08-16T00:00:00.000Z', 1)).toBe('2026-08-17T00:00:00.000Z')
  })

  it('throws rather than guessing a time', () => {
    expect(() => sourceDataExpiresAt('not-a-time')).toThrow(TypeError)
  })
})

describe('CanonicalEvent (spec §7.4)', () => {
  const event = {
    schemaVersion: CONTRACT_VERSION,
    eventKey: `youtube:${BROADCAST_ID}:msg_test_0001`,
    ingestSeq: 1,
    source: 'youtube',
    broadcastId: BROADCAST_ID,
    liveChatId: LIVE_CHAT_ID,
    kind: 'CHAT_COMMAND',
    occurredAt: '2026-08-16T00:00:00.000Z',
    receivedAt: RECEIVED_AT,
    actor: null,
    command: { name: 'FEED', argument: null },
    payment: null,
    sourceDataExpiresAt: sourceDataExpiresAt(RECEIVED_AT),
  }

  it('accepts the §7.4 shape', () => {
    expect(CanonicalEventSchema.parse(event)).toEqual(event)
  })

  it('accepts only null for actor while the identity gate is closed', () => {
    expect(
      CanonicalEventSchema.safeParse({ ...event, actor: { channelId: 'UC_TEST_0001' } }).success,
    ).toBe(false)
    expect(CanonicalEventSchema.safeParse({ ...event, actor: 'anonymous' }).success).toBe(false)
  })

  it('rejects an added identity field', () => {
    expect(
      CanonicalEventSchema.safeParse({ ...event, authorChannelId: 'UC_TEST_0001' }).success,
    ).toBe(false)
  })

  it('rejects a non-UTC timestamp', () => {
    expect(
      CanonicalEventSchema.safeParse({ ...event, occurredAt: '2026-08-16T09:00:00+09:00' }).success,
    ).toBe(false)
  })

  describe('enforces the §7.4 eventKey relation, not just its shape', () => {
    const giftEvent = {
      ...event,
      kind: 'GIFT',
      command: null,
      eventKey: `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:3`,
      payment: {
        amountMicros: null,
        currency: null,
        tier: null,
        jewels: 30,
        comboCount: 3,
        giftName: 'test_gift_lantern',
      },
    }

    it('accepts a gift event whose key restates its own fields', () => {
      expect(CanonicalEventSchema.parse(giftEvent)).toEqual(giftEvent)
    })

    it.each([
      [
        'a non-gift event carrying a gift suffix',
        { ...event, eventKey: `youtube:${BROADCAST_ID}:msg_test_0001:gift:3` },
      ],
      [
        'a gift event without the suffix',
        { ...giftEvent, eventKey: `youtube:${BROADCAST_ID}:msg_test_gift_0001` },
      ],
      [
        'a suffix that disagrees with the reported combo count',
        { ...giftEvent, eventKey: `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:9` },
      ],
      // An unreported count is not an unconstrained one: §7.4 makes it the
      // first gift, so `:gift:1` is the only key it can have.
      [
        'a gift with no combo count and an arbitrary suffix',
        {
          ...giftEvent,
          payment: { ...giftEvent.payment, comboCount: null },
          eventKey: `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:9`,
        },
      ],
      [
        'a gift with no payment at all and an arbitrary suffix',
        {
          ...giftEvent,
          payment: null,
          eventKey: `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:9`,
        },
      ],
      [
        'a key naming another source',
        { ...event, eventKey: `simulator:${BROADCAST_ID}:msg_test_0001` },
      ],
      ['a key naming another broadcast', { ...event, eventKey: 'youtube:bcast_test_OTHER:msg_1' }],
    ])('rejects %s', (_label, candidate) => {
      const result = CanonicalEventSchema.safeParse(candidate)
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['eventKey'])
    })

    it.each([
      ['combo count 0', { ...giftEvent.payment, comboCount: 0 }],
      ['no combo count', { ...giftEvent.payment, comboCount: null }],
      ['no payment', null],
    ])('accepts %s with the :gift:1 key the §7.4 rule produces', (_label, payment) => {
      const firstGift = {
        ...giftEvent,
        eventKey: `youtube:${BROADCAST_ID}:msg_test_gift_0001:gift:1`,
        payment,
      }
      expect(CanonicalEventSchema.safeParse(firstGift).success).toBe(true)
    })

    it.each(SHAPES)('%s: keys built from a fixture envelope satisfy the relation', (shape) => {
      for (const name of ['text-message-event', 'gift-event-combo-3', 'super-chat-event']) {
        const envelope = validEnvelope(shape, name)
        const candidate = {
          ...event,
          eventKey: eventKeyForEnvelope(envelope),
          kind: envelope.kind,
          command: envelope.command,
          payment: envelope.payment,
          occurredAt: envelope.occurredAt,
        }
        expect(CanonicalEventSchema.safeParse(candidate).success, `${shape}/${name}`).toBe(true)
      }
    })
  })

  it('rejects a payment amount that is not a whole non-negative number', () => {
    for (const amountMicros of [-1, 1.5, '550000']) {
      expect(
        CanonicalEventSchema.safeParse({
          ...event,
          kind: 'SUPER_CHAT',
          payment: {
            amountMicros,
            currency: 'JPY',
            tier: 2,
            jewels: null,
            comboCount: null,
            giftName: null,
          },
        }).success,
      ).toBe(false)
    }
  })
})
