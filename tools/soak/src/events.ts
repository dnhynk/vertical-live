import { CONTRACT_VERSION, IngestEnvelopeSchema, type IngestEnvelope } from '@vl/contract'

/**
 * The synthetic load a soak runs on (spec §11 무인성: "synthetic/replay 입력을
 * 포함한 72시간 soak").
 *
 * Every identifier is an obviously synthetic token and the source label stays
 * `simulator`, which is what keeps synthetic participation distinguishable from
 * real participation (spec §2.6, CLAUDE.md §3: 가짜 참여를 만들지 않는다). There
 * is no author, no display name and no channel id anywhere in this file — an
 * identity gate that is closed has nothing to carry (BOARD A-1).
 */

export const SOAK_BROADCAST_ID = 'brd_soak_0001'
export const SOAK_LIVE_CHAT_ID = 'chat_soak_0001'

/** The §7.1 free commands, cycled deterministically — no RNG, no seed to lose. */
const COMMANDS = ['FEED', 'PLAY', 'PET'] as const

export function soakCommandEnvelope(sequence: number, receivedAt: string): IngestEnvelope {
  const command = COMMANDS[sequence % COMMANDS.length] as (typeof COMMANDS)[number]
  return IngestEnvelopeSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'simulator',
    source: 'simulator',
    broadcastId: SOAK_BROADCAST_ID,
    liveChatId: SOAK_LIVE_CHAT_ID,
    receivedAt,
    messageId: `msg_soak_${String(sequence).padStart(8, '0')}`,
    validationStatus: 'valid',
    kind: 'CHAT_COMMAND',
    occurredAt: receivedAt,
    command: { name: command, argument: null },
    payment: null,
  })
}

export function soakCommandBatch(
  firstSequence: number,
  count: number,
  receivedAt: string,
): readonly IngestEnvelope[] {
  return Array.from({ length: count }, (_unused, index) =>
    soakCommandEnvelope(firstSequence + index, receivedAt),
  )
}
