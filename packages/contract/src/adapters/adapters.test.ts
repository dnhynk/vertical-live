import { describe, expect, it, vi } from 'vitest'

import type { CommandName, CommandParser } from '../commands.js'
import type { EventKind, SourceShape } from '../enums.js'
import { loadSourceFixture, listSourceFixtureNames } from '../fixtures/load.js'
import { IngestEnvelopeSchema, type IngestEnvelope, type ValidationErrorCode } from '../ingest.js'
import { CONTRACT_VERSION } from '../version.js'
import { fromGrpcStreamListItem } from './grpc.js'
import { fromRestListItem } from './rest.js'
import type { IngestAdapterContext } from './shared.js'

/**
 * Fixture-driven contract tests for the two source adapters (TASK_SPECS §T1
 * acceptance 1 and 4).
 *
 * The same eighteen-plus cases exist twice on disk: once in [S4] gRPC proto
 * snake_case and once in [S3] REST camelCase. Both must produce the *same*
 * envelope apart from `sourceShape`, and neither adapter may understand the
 * other's field names.
 */

const BROADCAST_ID = 'bcast_test_0001'
const LIVE_CHAT_ID = 'chat_test_0001'
const RECEIVED_AT = '2026-08-16T00:10:00.000Z'

/**
 * Stand-in for the T6 parser: exact match only. These tests exercise the
 * adapter's handling of a parser result, not normalization, which is T6.
 */
const STUB_ALIASES: Readonly<Record<string, CommandName>> = {
  ごはん: 'FEED',
  あそぶ: 'PLAY',
  なでる: 'PET',
}

const stubParser: CommandParser = (rawText) => {
  const name = STUB_ALIASES[rawText]
  return name === undefined ? null : { name, argument: null }
}

function context(parseCommand: CommandParser = stubParser): IngestAdapterContext {
  return {
    broadcastId: BROADCAST_ID,
    liveChatId: LIVE_CHAT_ID,
    receivedAt: RECEIVED_AT,
    parseCommand,
  }
}

type Adapter = (item: unknown, ctx: IngestAdapterContext) => IngestEnvelope

const ADAPTERS: Readonly<Record<SourceShape & ('grpc' | 'rest'), Adapter>> = {
  grpc: fromGrpcStreamListItem,
  rest: fromRestListItem,
}

const SHAPES = ['grpc', 'rest'] as const

/** Exactly the keys a valid envelope may carry (spec §7.3(1)). */
const VALID_KEYS = [
  'broadcastId',
  'command',
  'kind',
  'liveChatId',
  'messageId',
  'occurredAt',
  'payment',
  'receivedAt',
  'schemaVersion',
  'source',
  'sourceShape',
  'validationStatus',
]

/** The minimum envelope an unsupported or invalid item still produces. */
const REJECTED_KEYS = [
  'broadcastId',
  'liveChatId',
  'messageId',
  'receivedAt',
  'schemaVersion',
  'source',
  'sourceShape',
  'validationError',
  'validationStatus',
]

interface ValidExpectation {
  readonly status: 'valid'
  readonly messageId: string
  readonly kind: EventKind
  readonly occurredAt: string
  readonly command: CommandName | null
  readonly payment: Readonly<Record<string, unknown>> | null
}

interface RejectedExpectation {
  readonly status: 'unsupported' | 'invalid'
  readonly messageId: string | null
  readonly code: ValidationErrorCode
  readonly field: string | null
  /** Source field path differs per shape; `null` when the code carries none. */
  readonly restField?: string
  readonly sourceMessageType: Readonly<Record<'grpc' | 'rest', string | null>>
}

type Expectation = ValidExpectation | RejectedExpectation

function giftPayment(comboCount: number): Record<string, unknown> {
  return {
    amountMicros: null,
    currency: null,
    tier: null,
    jewels: 30,
    comboCount,
    giftName: 'test_gift_lantern',
  }
}

function amountPayment(amountMicros: number, tier: number): Record<string, unknown> {
  return {
    amountMicros,
    currency: 'JPY',
    tier,
    jewels: null,
    comboCount: null,
    giftName: null,
  }
}

/**
 * One row per fixture. A new fixture without a row fails `covers every fixture`
 * below, so the table cannot silently fall behind the fixture directory.
 */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  'text-message-event': {
    status: 'valid',
    messageId: 'msg_test_0001',
    kind: 'CHAT_COMMAND',
    occurredAt: '2026-08-16T00:00:00.000Z',
    command: 'FEED',
    payment: null,
  },
  // Full-width letters, a zero-width space, a URL and a banned-word marker. The
  // stub parser matches exact aliases only, so this is the "no command" path;
  // normalizing it into FEED is T6's job.
  'text-message-event-noise': {
    status: 'valid',
    messageId: 'msg_test_0002',
    kind: 'CHAT_COMMAND',
    occurredAt: '2026-08-16T00:00:30.000Z',
    command: null,
    payment: null,
  },
  'super-chat-event': {
    status: 'valid',
    messageId: 'msg_test_0003',
    kind: 'SUPER_CHAT',
    occurredAt: '2026-08-16T00:01:00.000Z',
    command: null,
    payment: amountPayment(550_000, 2),
  },
  'super-sticker-event': {
    status: 'valid',
    messageId: 'msg_test_0004',
    kind: 'SUPER_STICKER',
    occurredAt: '2026-08-16T00:01:30.000Z',
    command: null,
    payment: amountPayment(1_200_000, 3),
  },
  'gift-event-combo-0': {
    status: 'valid',
    messageId: 'msg_test_gift_0001',
    kind: 'GIFT',
    occurredAt: '2026-08-16T00:03:00.000Z',
    command: null,
    payment: giftPayment(0),
  },
  'gift-event-combo-1': {
    status: 'valid',
    messageId: 'msg_test_gift_0001',
    kind: 'GIFT',
    occurredAt: '2026-08-16T00:03:02.000Z',
    command: null,
    payment: giftPayment(1),
  },
  'gift-event-combo-3': {
    status: 'valid',
    messageId: 'msg_test_gift_0001',
    kind: 'GIFT',
    occurredAt: '2026-08-16T00:03:05.000Z',
    command: null,
    payment: giftPayment(3),
  },
  'gift-event-combo-5': {
    status: 'valid',
    messageId: 'msg_test_gift_0001',
    kind: 'GIFT',
    occurredAt: '2026-08-16T00:03:09.000Z',
    command: null,
    payment: giftPayment(5),
  },
  // Membership details carry a level name and a gift count; neither has a field
  // in the §7.4 payment contract, so `payment` stays null.
  'new-sponsor-event': {
    status: 'valid',
    messageId: 'msg_test_0005',
    kind: 'MEMBERSHIP',
    occurredAt: '2026-08-16T00:04:00.000Z',
    command: null,
    payment: null,
  },
  'member-milestone-chat-event': {
    status: 'valid',
    messageId: 'msg_test_0006',
    kind: 'MEMBERSHIP',
    occurredAt: '2026-08-16T00:04:30.000Z',
    command: null,
    payment: null,
  },
  'membership-gifting-event': {
    status: 'valid',
    messageId: 'msg_test_0007',
    kind: 'MEMBERSHIP',
    occurredAt: '2026-08-16T00:05:00.000Z',
    command: null,
    payment: null,
  },
  'gift-membership-received-event': {
    status: 'valid',
    messageId: 'msg_test_0008',
    kind: 'MEMBERSHIP',
    occurredAt: '2026-08-16T00:05:05.000Z',
    command: null,
    payment: null,
  },
  'unsupported-chat-ended-event': {
    status: 'unsupported',
    messageId: 'msg_test_0009',
    code: 'UNSUPPORTED_MESSAGE_TYPE',
    field: 'snippet.type',
    sourceMessageType: { grpc: 'CHAT_ENDED_EVENT', rest: 'chatEndedEvent' },
  },
  'unsupported-user-banned-event': {
    status: 'unsupported',
    messageId: 'msg_test_0010',
    code: 'UNSUPPORTED_MESSAGE_TYPE',
    field: 'snippet.type',
    sourceMessageType: { grpc: 'USER_BANNED_EVENT', rest: 'userBannedEvent' },
  },
  'invalid-missing-published-at': {
    status: 'invalid',
    messageId: 'msg_test_0011',
    code: 'MISSING_PUBLISHED_AT',
    field: 'snippet.published_at',
    restField: 'snippet.publishedAt',
    sourceMessageType: { grpc: 'TEXT_MESSAGE_EVENT', rest: 'textMessageEvent' },
  },
  'invalid-malformed-amount': {
    status: 'invalid',
    messageId: 'msg_test_0012',
    code: 'MALFORMED_AMOUNT',
    field: 'snippet.super_chat_details.amount_micros',
    restField: 'snippet.superChatDetails.amountMicros',
    sourceMessageType: { grpc: 'SUPER_CHAT_EVENT', rest: 'superChatEvent' },
  },
  // A date without a time is not an instant; accepting it would silently pin the
  // event to midnight UTC (spec §10.2).
  'invalid-date-only-published-at': {
    status: 'invalid',
    messageId: 'msg_test_0017',
    code: 'MALFORMED_PUBLISHED_AT',
    field: 'snippet.published_at',
    restField: 'snippet.publishedAt',
    sourceMessageType: { grpc: 'TEXT_MESSAGE_EVENT', rest: 'textMessageEvent' },
  },
  'invalid-live-chat-id-mismatch': {
    status: 'invalid',
    messageId: 'msg_test_0013',
    code: 'LIVE_CHAT_ID_MISMATCH',
    field: 'snippet.live_chat_id',
    restField: 'snippet.liveChatId',
    sourceMessageType: { grpc: 'TEXT_MESSAGE_EVENT', rest: 'textMessageEvent' },
  },
  'invalid-missing-gift-details': {
    status: 'invalid',
    messageId: 'msg_test_0014',
    code: 'MISSING_EVENT_DETAILS',
    field: 'snippet.gift_details',
    restField: 'snippet.giftEventDetails',
    sourceMessageType: { grpc: 'GIFT_EVENT', rest: 'giftEvent' },
  },
  'invalid-missing-id': {
    status: 'invalid',
    messageId: null,
    code: 'MISSING_MESSAGE_ID',
    field: 'id',
    sourceMessageType: { grpc: null, rest: null },
  },
  // An id carrying the eventKey separator is dropped, not stored: it would forge
  // a key segment (spec §7.4) and it does not fit `ExternalIdSchema` either.
  'invalid-message-id-charset': {
    status: 'invalid',
    messageId: null,
    code: 'MALFORMED_MESSAGE_ID',
    field: 'id',
    sourceMessageType: { grpc: null, rest: null },
  },
  'invalid-negative-tier': {
    status: 'invalid',
    messageId: 'msg_test_0015',
    code: 'MALFORMED_TIER',
    field: 'snippet.super_chat_details.tier',
    restField: 'snippet.superChatDetails.tier',
    sourceMessageType: { grpc: 'SUPER_CHAT_EVENT', rest: 'superChatEvent' },
  },
  'invalid-negative-jewels': {
    status: 'invalid',
    messageId: 'msg_test_gift_0002',
    code: 'MALFORMED_JEWELS',
    field: 'snippet.gift_details.jewels_amount',
    restField: 'snippet.giftEventDetails.giftMetadata.jewelsAmount',
    sourceMessageType: { grpc: 'GIFT_EVENT', rest: 'giftEvent' },
  },
  'invalid-negative-combo-count': {
    status: 'invalid',
    messageId: 'msg_test_gift_0003',
    code: 'MALFORMED_COMBO_COUNT',
    field: 'snippet.gift_details.combo_count',
    restField: 'snippet.giftEventDetails.giftMetadata.comboCount',
    sourceMessageType: { grpc: 'GIFT_EVENT', rest: 'giftEvent' },
  },
}

function adapt(shape: 'grpc' | 'rest', name: string, ctx = context()): IngestEnvelope {
  return ADAPTERS[shape](loadSourceFixture(shape, name).item, ctx)
}

describe.each(SHAPES)('%s fixtures', (shape) => {
  const names = listSourceFixtureNames(shape)

  it('covers every fixture with an expectation row', () => {
    expect(names.slice().sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it.each(names)('%s produces a schema-valid envelope', (name) => {
    const parsed = IngestEnvelopeSchema.safeParse(adapt(shape, name))
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  it.each(names)('%s carries the ingest context and contract version', (name) => {
    expect(adapt(shape, name)).toMatchObject({
      schemaVersion: CONTRACT_VERSION,
      sourceShape: shape,
      source: 'youtube',
      broadcastId: BROADCAST_ID,
      liveChatId: LIVE_CHAT_ID,
      receivedAt: RECEIVED_AT,
    })
  })

  it.each(names)('%s matches its expectation row exactly', (name) => {
    const expected = EXPECTED[name]
    if (expected === undefined) throw new Error(`no expectation row for ${name}`)
    const envelope = adapt(shape, name)

    if (expected.status === 'valid') {
      expect(Object.keys(envelope).sort()).toEqual(VALID_KEYS)
      expect(envelope).toMatchObject({
        validationStatus: 'valid',
        messageId: expected.messageId,
        kind: expected.kind,
        occurredAt: expected.occurredAt,
        command: expected.command === null ? null : { name: expected.command, argument: null },
        payment: expected.payment,
      })
      return
    }

    expect(Object.keys(envelope).sort()).toEqual(REJECTED_KEYS)
    expect(envelope).toMatchObject({
      validationStatus: expected.status,
      messageId: expected.messageId,
      validationError: {
        code: expected.code,
        field: shape === 'rest' ? (expected.restField ?? expected.field) : expected.field,
        sourceMessageType: expected.sourceMessageType[shape],
      },
    })
  })
})

describe('the two shapes agree', () => {
  /**
   * `validationError.field` and `.sourceMessageType` quote the *source* item, so
   * they are snake_case for gRPC and camelCase for REST by design. Everything
   * else — the normalized part of the envelope — must be identical.
   */
  function comparable(envelope: IngestEnvelope): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...envelope }
    delete normalized.sourceShape
    if (envelope.validationStatus !== 'valid') {
      normalized.validationError = envelope.validationError.code
    }
    return normalized
  }

  it.each(listSourceFixtureNames('grpc'))(
    '%s normalizes identically apart from sourceShape',
    (name) => {
      expect(adapt('grpc', name).sourceShape).toBe('grpc')
      expect(adapt('rest', name).sourceShape).toBe('rest')
      expect(comparable(adapt('grpc', name))).toEqual(comparable(adapt('rest', name)))
    },
  )

  it('ships the same fixture names for both shapes', () => {
    expect(listSourceFixtureNames('grpc')).toEqual(listSourceFixtureNames('rest'))
  })
})

describe('field names are never mixed', () => {
  it('the gRPC adapter does not recognize REST type tokens', () => {
    const envelope = fromGrpcStreamListItem(
      loadSourceFixture('rest', 'super-chat-event').item,
      context(),
    )
    expect(envelope.validationStatus).toBe('unsupported')
  })

  it('the REST adapter does not recognize gRPC type tokens', () => {
    const envelope = fromRestListItem(loadSourceFixture('grpc', 'super-chat-event').item, context())
    expect(envelope.validationStatus).toBe('unsupported')
  })

  it('the gRPC adapter does not read camelCase detail fields', () => {
    // gRPC type token, REST payload field names: the details must read as absent.
    const hybrid = {
      id: 'msg_test_hybrid_1',
      snippet: {
        type: 'SUPER_CHAT_EVENT',
        liveChatId: LIVE_CHAT_ID,
        publishedAt: '2026-08-16T00:00:00.000Z',
        superChatDetails: { amountMicros: '100', currency: 'JPY', tier: 1 },
      },
    }
    expect(fromGrpcStreamListItem(hybrid, context())).toMatchObject({
      validationStatus: 'invalid',
      validationError: { code: 'MISSING_PUBLISHED_AT', field: 'snippet.published_at' },
    })
  })

  it('the REST adapter does not read snake_case detail fields', () => {
    const hybrid = {
      id: 'msg_test_hybrid_2',
      snippet: {
        type: 'superChatEvent',
        live_chat_id: LIVE_CHAT_ID,
        published_at: '2026-08-16T00:00:00.000Z',
        super_chat_details: { amount_micros: '100', currency: 'JPY', tier: 1 },
      },
    }
    expect(fromRestListItem(hybrid, context())).toMatchObject({
      validationStatus: 'invalid',
      validationError: { code: 'MISSING_PUBLISHED_AT', field: 'snippet.publishedAt' },
    })
  })

  it.each(SHAPES)('%s rejects a non-object item', (shape) => {
    expect(ADAPTERS[shape]('not an item', context())).toMatchObject({
      validationStatus: 'invalid',
      messageId: null,
      validationError: { code: 'MALFORMED_ITEM', field: null },
    })
  })
})

describe('malformed source numbers and ids stay envelopes (spec §7.3(1))', () => {
  const PUBLISHED_AT = '2026-08-16T00:00:00.000Z'

  function superChatItem(shape: 'grpc' | 'rest', patch: Record<string, unknown>): unknown {
    return shape === 'grpc'
      ? {
          id: 'msg_test_probe_0001',
          snippet: {
            type: 'SUPER_CHAT_EVENT',
            live_chat_id: LIVE_CHAT_ID,
            published_at: PUBLISHED_AT,
            super_chat_details: { amount_micros: '550000', currency: 'JPY', tier: 2, ...patch },
          },
        }
      : {
          id: 'msg_test_probe_0001',
          snippet: {
            type: 'superChatEvent',
            liveChatId: LIVE_CHAT_ID,
            publishedAt: PUBLISHED_AT,
            superChatDetails: { amountMicros: '550000', currency: 'JPY', tier: 2, ...patch },
          },
        }
  }

  function giftItem(shape: 'grpc' | 'rest', patch: Record<string, unknown>): unknown {
    return shape === 'grpc'
      ? {
          id: 'msg_test_probe_0002',
          snippet: {
            type: 'GIFT_EVENT',
            live_chat_id: LIVE_CHAT_ID,
            published_at: PUBLISHED_AT,
            gift_details: {
              gift_name: 'test_gift_lantern',
              jewels_amount: 30,
              combo_count: 1,
              ...patch,
            },
          },
        }
      : {
          id: 'msg_test_probe_0002',
          snippet: {
            type: 'giftEvent',
            liveChatId: LIVE_CHAT_ID,
            publishedAt: PUBLISHED_AT,
            giftEventDetails: {
              giftMetadata: {
                giftName: 'test_gift_lantern',
                jewelsAmount: 30,
                comboCount: 1,
                ...patch,
              },
            },
          },
        }
  }

  /** Values no source number may become. `0` is added per field where the contract requires ≥ 1. */
  const HOSTILE_VALUES: readonly unknown[] = [
    -1,
    -1000,
    1.5,
    '-1',
    '1.5',
    'five-hundred',
    '',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 60,
    true,
    {},
    [],
  ]

  interface NumericProbe {
    readonly code: ValidationErrorCode
    readonly keys: Readonly<Record<'grpc' | 'rest', string>>
    readonly build: (shape: 'grpc' | 'rest', patch: Record<string, unknown>) => unknown
    /** `''` and an absent value mean "not reported"; only a required field rejects them. */
    readonly rejectsAbsent: boolean
    readonly extraHostile?: readonly unknown[]
  }

  const NUMERIC_PROBES: readonly NumericProbe[] = [
    {
      code: 'MALFORMED_AMOUNT',
      keys: { grpc: 'amount_micros', rest: 'amountMicros' },
      build: superChatItem,
      rejectsAbsent: true,
    },
    {
      code: 'MALFORMED_TIER',
      keys: { grpc: 'tier', rest: 'tier' },
      build: superChatItem,
      rejectsAbsent: false,
      // `tier` is 1-based in [S3]; 0 is not a tier.
      extraHostile: [0],
    },
    {
      code: 'MALFORMED_JEWELS',
      keys: { grpc: 'jewels_amount', rest: 'jewelsAmount' },
      build: giftItem,
      rejectsAbsent: false,
    },
    {
      code: 'MALFORMED_COMBO_COUNT',
      keys: { grpc: 'combo_count', rest: 'comboCount' },
      build: giftItem,
      rejectsAbsent: false,
    },
  ]

  describe.each(SHAPES)('%s', (shape) => {
    it.each(NUMERIC_PROBES.map((probe) => [probe.code, probe] as const))(
      'maps every malformed value of the %s field to that code, never an exception',
      (_code, probe) => {
        const hostile = [...HOSTILE_VALUES, ...(probe.extraHostile ?? [])].filter(
          (value) => value !== '' || probe.rejectsAbsent,
        )
        for (const value of hostile) {
          const item = probe.build(shape, { [probe.keys[shape]]: value })
          const envelope = ADAPTERS[shape](item, context())
          expect(IngestEnvelopeSchema.safeParse(envelope).success).toBe(true)
          expect(envelope, `${shape} ${probe.code} ${JSON.stringify(value)}`).toMatchObject({
            validationStatus: 'invalid',
            validationError: { code: probe.code },
          })
          expect(Object.keys(envelope).sort()).toEqual(REJECTED_KEYS)
        }
      },
    )

    it.each(NUMERIC_PROBES.map((probe) => [probe.code, probe] as const))(
      'treats an absent field the way the contract does (%s)',
      (_code, probe) => {
        const item = probe.build(shape, { [probe.keys[shape]]: undefined })
        const envelope = ADAPTERS[shape](item, context())
        expect(envelope.validationStatus).toBe(probe.rejectsAbsent ? 'invalid' : 'valid')
      },
    )

    it('still accepts the string encoding of a large integer', () => {
      const envelope = ADAPTERS[shape](superChatItem(shape, { tier: '5' }), context())
      expect(envelope).toMatchObject({
        validationStatus: 'valid',
        payment: { amountMicros: 550_000, tier: 5 },
      })
    })

    it('normalizes an absent combo count to the first gift', () => {
      const key = shape === 'grpc' ? 'combo_count' : 'comboCount'
      const envelope = ADAPTERS[shape](giftItem(shape, { [key]: undefined }), context())
      expect(envelope).toMatchObject({
        validationStatus: 'valid',
        payment: { comboCount: 0, jewels: 30 },
      })
    })

    it.each(['msg_test:0001', 'msg test 0001', 'msg#0001', 'a'.repeat(129), '../etc/passwd'])(
      'rejects the unusable message id %s without storing it',
      (id) => {
        const item = { ...(superChatItem(shape, {}) as Record<string, unknown>), id }
        const envelope = ADAPTERS[shape](item, context())
        expect(envelope).toMatchObject({
          validationStatus: 'invalid',
          messageId: null,
          validationError: { code: 'MALFORMED_MESSAGE_ID', field: 'id' },
        })
        expect(JSON.stringify(envelope)).not.toContain(id)
      },
    )

    it.each([
      '2026-08-17',
      '0',
      '08/17/2026',
      '2026-08-16T00:00:00',
      '2026-02-30T00:00:00Z',
      1_755_302_400_000,
    ])('rejects the non-ISO publish time %s', (publishedAt) => {
      const key = shape === 'grpc' ? 'published_at' : 'publishedAt'
      const item = superChatItem(shape, {}) as { snippet: Record<string, unknown> }
      const envelope = ADAPTERS[shape](
        { ...item, snippet: { ...item.snippet, [key]: publishedAt } },
        context(),
      )
      expect(envelope).toMatchObject({
        validationStatus: 'invalid',
        validationError: { code: 'MALFORMED_PUBLISHED_AT', field: `snippet.${key}` },
      })
    })

    it('accepts a message id at the length limit', () => {
      const id = 'a'.repeat(128)
      const item = { ...(superChatItem(shape, {}) as Record<string, unknown>), id }
      expect(ADAPTERS[shape](item, context())).toMatchObject({
        validationStatus: 'valid',
        messageId: id,
      })
    })
  })
})

describe('payment never buys input (spec §8.5)', () => {
  const PAID_FIXTURES = [
    'super-chat-event',
    'super-sticker-event',
    'member-milestone-chat-event',
    'gift-event-combo-1',
  ]

  it.each(SHAPES)('%s never offers a paid comment to the command parser', (shape) => {
    for (const name of PAID_FIXTURES) {
      const parseCommand = vi.fn<CommandParser>(() => ({ name: 'FEED', argument: null }))
      const envelope = adapt(shape, name, context(parseCommand))
      expect(parseCommand, `${shape}/${name}`).not.toHaveBeenCalled()
      expect(envelope).toMatchObject({ validationStatus: 'valid', command: null })
    }
  })

  it.each(SHAPES)('%s offers only free chat text, and stores none of it', (shape) => {
    const parseCommand = vi.fn<CommandParser>(stubParser)
    const envelope = adapt(shape, 'text-message-event', context(parseCommand))
    expect(parseCommand).toHaveBeenCalledExactlyOnceWith('ごはん')
    expect(envelope).toMatchObject({ command: { name: 'FEED', argument: null } })
    expect(JSON.stringify(envelope)).not.toContain('ごはん')
  })
})

describe('no identity or raw text survives normalization (spec §7.3(1), §12.3)', () => {
  /**
   * Synthetic identity and free-text values present in the fixtures. None of
   * them may appear anywhere in an envelope, at any key, for any fixture.
   */
  const MUST_NOT_APPEAR = [
    'UC_TEST_SYNTHETIC_0001',
    'UC_TEST_SYNTHETIC_0002',
    'UC_TEST_SYNTHETIC_0003',
    'TEST SYNTHETIC AUTHOR',
    'example.invalid',
    'ごはん',
    'あそぶ',
    'なでる',
    'ＦＥＥＤ',
    'NGWORD_TEST',
    'test_level_a',
    'test gift',
    'sticker_test_0001',
    '¥550',
    '¥1,200',
  ]

  it.each(SHAPES)('%s envelopes contain no fixture identity or message text', (shape) => {
    for (const name of listSourceFixtureNames(shape)) {
      const serialized = JSON.stringify(adapt(shape, name))
      for (const forbidden of MUST_NOT_APPEAR) {
        expect(serialized, `${shape}/${name} leaked ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it.each(SHAPES)('%s keeps the subscribed liveChatId, not the item claim', (shape) => {
    const envelope = adapt(shape, 'invalid-live-chat-id-mismatch')
    expect(envelope.liveChatId).toBe(LIVE_CHAT_ID)
    expect(JSON.stringify(envelope)).not.toContain('chat_test_OTHER')
  })
})
