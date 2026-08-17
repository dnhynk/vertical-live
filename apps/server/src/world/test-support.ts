import {
  CONTRACT_VERSION,
  eventKeyFor,
  giftEventKeyFor,
  sourceDataExpiresAt,
  type CanonicalEvent,
  type CommandName,
  type EventKind,
  type IsoUtcInstant,
  type PaymentDetails,
} from '@vl/contract'

/**
 * Synthetic canonical events for the world tests.
 *
 * Every identifier is an obviously synthetic value (`bc_test_…`, `msg_test_…`)
 * and `source` is `simulator`, so nothing here can be mistaken for a real
 * viewer, a real payment or a real broadcast (spec §2.6). There is no author,
 * name or raw text field to fill in — the contract has none (spec §7.4).
 *
 * This module is test scaffolding; no production module imports it.
 */

export const TEST_BROADCAST_ID = 'bc_test_1'
export const TEST_LIVE_CHAT_ID = 'lc_test_1'

let sequence = 0

export function resetTestSequence(): void {
  sequence = 0
}

function nextSequence(): number {
  sequence += 1
  return sequence
}

export interface TestEventOptions {
  readonly kind?: EventKind
  readonly command?: CommandName | null
  readonly payment?: PaymentDetails | null
  readonly occurredAt?: IsoUtcInstant
  readonly messageId?: string
  readonly ingestSeq?: number
}

export function testEvent(at: IsoUtcInstant, options: TestEventOptions = {}): CanonicalEvent {
  const kind = options.kind ?? 'CHAT_COMMAND'
  const seq = nextSequence()
  const messageId = options.messageId ?? `msg_test_${String(seq).padStart(4, '0')}`
  const parts = {
    source: 'simulator' as const,
    broadcastId: TEST_BROADCAST_ID,
    messageId,
  }
  return {
    schemaVersion: CONTRACT_VERSION,
    eventKey:
      kind === 'GIFT'
        ? giftEventKeyFor({ ...parts, comboCount: options.payment?.comboCount ?? null })
        : eventKeyFor(parts),
    ingestSeq: options.ingestSeq ?? seq,
    source: 'simulator',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    kind,
    occurredAt: options.occurredAt ?? at,
    receivedAt: at,
    actor: null,
    command: options.command === undefined ? null : commandRef(options.command),
    payment: options.payment ?? null,
    sourceDataExpiresAt: sourceDataExpiresAt(at),
  }
}

function commandRef(name: CommandName | null): CanonicalEvent['command'] {
  return name === null ? null : { name, argument: null }
}

/** A free care or vote command event. */
export function commandEvent(at: IsoUtcInstant, name: CommandName): CanonicalEvent {
  return testEvent(at, { kind: 'CHAT_COMMAND', command: name })
}

/** A paid event with synthetic, structurally valid payment fields. */
export function paidEvent(
  at: IsoUtcInstant,
  kind: 'SUPER_CHAT' | 'SUPER_STICKER' | 'GIFT' | 'MEMBERSHIP',
  overrides: Partial<PaymentDetails> = {},
  occurredAt?: IsoUtcInstant,
): CanonicalEvent {
  const payment: PaymentDetails = {
    amountMicros: 500_000_000,
    currency: 'JPY',
    tier: 2,
    jewels: null,
    comboCount: kind === 'GIFT' ? 1 : null,
    giftName: kind === 'GIFT' ? 'test gift' : null,
    ...overrides,
  }
  return testEvent(at, { kind, command: null, payment, occurredAt })
}
