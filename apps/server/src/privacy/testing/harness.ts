import { CONTRACT_VERSION, eventKeyFor, giftEventKeyFor, type IngestEnvelope } from '@vl/contract'

import { openDatabase, type PersistenceStore } from '../../db/index.js'
import {
  makePaidEffect,
  makeSnapshot,
  TEST_BROADCAST_ID,
  TEST_LIVE_CHAT_ID,
  TEST_SOURCE_KEY,
} from '../../db/testing/fixtures.js'
import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { loadRetentionConfig, type RetentionConfig } from '../config.js'

/**
 * Shared setup for the retention, revocation and deletion-request tests.
 *
 * The real `config/retention.json` is used, not a test-only copy: the acceptance
 * criteria are about the policy this repository ships, so a test that invented its
 * own schedule would prove nothing (TASK_SPECS §T13).
 *
 * Every id here is obviously synthetic (spec §2.6) and no helper can produce a
 * name, channel id or raw text — the contract has no field for them.
 */

/** 2026-01-01T00:00:00.000Z. An obvious synthetic instant, not "now". */
export const EPOCH_MS = Date.UTC(2026, 0, 1)
export const DAY_MS = 24 * 60 * 60 * 1000

export interface RetentionHarness {
  readonly temp: TempStore
  readonly store: PersistenceStore
  readonly clock: FakeClock
  readonly config: RetentionConfig
  dispose(): void
}

export function createRetentionHarness(): RetentionHarness {
  const clock = new FakeClock({ epochMs: EPOCH_MS })
  const temp = createTempStore({ clock })
  return {
    temp,
    store: temp.store,
    clock,
    config: loadRetentionConfig(),
    dispose: () => {
      temp.dispose()
    },
  }
}

/** A valid free-command envelope with a caller-chosen id and receipt instant. */
export function commandEnvelope(messageId: string, receivedAt: string): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'grpc',
    source: 'youtube',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt,
    messageId,
    validationStatus: 'valid',
    kind: 'CHAT_COMMAND',
    occurredAt: receivedAt,
    command: { name: 'FEED', argument: null },
    payment: null,
  }
}

/** A gift envelope, so `gift_combo` has a base key to be orphaned from. */
export function giftEnvelope(
  messageId: string,
  receivedAt: string,
  comboCount: number,
): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'grpc',
    source: 'youtube',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt,
    messageId,
    validationStatus: 'valid',
    kind: 'GIFT',
    occurredAt: receivedAt,
    command: null,
    payment: {
      amountMicros: null,
      currency: null,
      tier: null,
      jewels: 20,
      comboCount,
      giftName: 'test_gift',
    },
  }
}

export function baseKeyOf(messageId: string): string {
  return eventKeyFor({ source: 'youtube', broadcastId: TEST_BROADCAST_ID, messageId })
}

export function giftKeyOf(messageId: string, comboCount: number): string {
  return giftEventKeyFor({
    source: 'youtube',
    broadcastId: TEST_BROADCAST_ID,
    messageId,
    comboCount,
  })
}

/** Commits `count` command envelopes received at `receivedAt`. */
export function seedInbox(
  store: PersistenceStore,
  count: number,
  receivedAt: string,
  prefix = 'msg_test',
): number[] {
  const envelopes = Array.from({ length: count }, (_unused, index) =>
    commandEnvelope(`${prefix}_${String(index).padStart(4, '0')}`, receivedAt),
  )
  const result = store.commitIngestBatch(envelopes, {
    sourceKey: TEST_SOURCE_KEY,
    liveChatId: TEST_LIVE_CHAT_ID,
    nextPageToken: 'token_test_0001',
  })
  return result.results.map((entry) => entry.ingestSeq)
}

export interface SeededStateOptions {
  /** Instant used for the transition, the paid row and the effect window. */
  readonly at: string
  readonly revision: number
  readonly processedSeq: number
  /** Inbox sequences to mark processed in the same transaction. */
  readonly processed?: readonly number[]
  readonly paidMessageId?: string
  readonly giftMessageId?: string
  readonly giftComboCount?: number
}

/**
 * Commits one state transition carrying a transition row, a paid ledger row, a
 * paid effect and (optionally) a gift combo maximum — one row in each of the
 * tables whose retention is driven by an instant of its own.
 */
export function seedState(store: PersistenceStore, options: SeededStateOptions): void {
  const paidMessageId = options.paidMessageId ?? 'msg_test_paid_0001'
  const paidKey = baseKeyOf(paidMessageId)
  store.commitStateTransition({
    snapshot: makeSnapshot({
      stateRevision: options.revision,
      processedIngestSeq: options.processedSeq,
      worldTimeUtc: options.at,
    }),
    revision: options.revision,
    processedSeq: options.processedSeq,
    transitions: [
      { revision: options.revision, causedByEventKey: paidKey, kind: 'PAID_THANKS', at: options.at },
    ],
    processed: (options.processed ?? []).map((ingestSeq) => ({
      ingestSeq,
      result: 'applied',
      at: options.at,
    })),
    deadlines: [
      {
        id: `dl_test_${String(options.revision)}`,
        kind: 'test_choice_window',
        dueAt: options.at,
        policy: 'skip',
        payload: { test: true },
        status: 'fired',
      },
    ],
    effects: [
      makePaidEffect({
        effectId: `eff_test_${String(options.revision)}`,
        stateRevision: options.revision,
        causedByEventKey: paidKey,
        startsAt: options.at,
        endsAt: options.at,
      }),
    ],
    paidLedger: [
      {
        eventKey: paidKey,
        kind: 'SUPER_CHAT',
        amountMicros: 1_000_000,
        currency: 'JPY',
        tier: 1,
        jewels: null,
        appliedAt: options.at,
      },
    ],
    ...(options.giftMessageId === undefined
      ? {}
      : {
          giftCombo: [
            {
              baseKey: baseKeyOf(options.giftMessageId),
              effectiveCount: options.giftComboCount ?? 1,
            },
          ],
        }),
  })
}

/**
 * Inserts a `broadcast_resources` row over a second connection.
 *
 * T10 owns that table's writer, so there is no store method to call yet; the row
 * still has to exist for the retention sweep over it to be proven rather than
 * assumed. WAL allows the extra connection and it is closed immediately.
 */
export function insertBroadcastResource(
  file: string,
  broadcastId: string,
  updatedAt: string,
): void {
  const database = openDatabase({ file, busyTimeoutMs: 1000 })
  try {
    database
      .prepare(
        `INSERT INTO broadcast_resources
           (broadcast_id, live_chat_id, stream_id, lifecycle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(broadcastId, TEST_LIVE_CHAT_ID, 'stream_test_0001', 'live', updatedAt, updatedAt)
  } finally {
    database.close()
  }
}

/** Row count of a table, for assertions that do not go through the store API. */
export function rowCount(store: PersistenceStore, table: string): number {
  return store.countRows(table)
}
