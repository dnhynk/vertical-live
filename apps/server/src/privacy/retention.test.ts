import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/index.js'
import { RetentionConfigError, type RetentionConfig } from './config.js'
import { RetentionSweeper, minusDays, type Reverifier } from './retention.js'
import {
  DAY_MS,
  createRetentionHarness,
  giftEnvelope,
  insertBroadcastResource,
  seedInbox,
  seedState,
  type RetentionHarness,
} from './testing/harness.js'
import { TEST_LIVE_CHAT_ID, TEST_SOURCE_KEY } from '../db/testing/fixtures.js'

/**
 * TASK_SPECS §T13 acceptance 1, deletion half: with a virtual clock, data past
 * its allowed period is deleted and the deletion is recorded (spec §12.4).
 *
 * Every test drives time with `FakeClock`, never with a real wait, and reads the
 * evidence back out of `retention_ledger` rather than trusting the return value.
 */

const T0 = '2026-01-01T00:00:00.000Z'

let harness: RetentionHarness | undefined

afterEach(() => {
  harness?.dispose()
  harness = undefined
})

function open(): RetentionHarness {
  harness = createRetentionHarness()
  return harness
}

function sweeper(
  active: RetentionHarness,
  options: { reverify?: Reverifier } = {},
): RetentionSweeper {
  return new RetentionSweeper({
    store: active.store,
    clock: active.clock,
    config: active.config,
    ...(options.reverify === undefined ? {} : { reverify: options.reverify }),
  })
}

describe('scheduled retention sweep', () => {
  it('keeps source data until its allowed period has fully elapsed', async () => {
    const active = open()
    seedInbox(active.store, 3, T0)

    await active.clock.advance(29 * DAY_MS)
    const before = sweeper(active).run()

    expect(active.store.countRows('ingest_inbox')).toBe(3)
    const inbox = before.entries.find((entry) => entry.table === 'ingest_inbox')
    expect(inbox?.outcome).toBe('nothing_expired')
    expect(inbox?.rowsDeleted).toBe(0)

    // Exactly 30 days is still inside the window: the row's own deadline is
    // `receivedAt + 30일`, so it may live until that instant has passed.
    await active.clock.advance(DAY_MS)
    expect(sweeper(active).run().rowsDeleted).toBe(0)
    expect(active.store.countRows('ingest_inbox')).toBe(3)
  })

  it('deletes and records once 30 days have passed', async () => {
    const active = open()
    seedInbox(active.store, 3, T0)

    await active.clock.advance(30 * DAY_MS + 1)
    const result = sweeper(active).run()

    expect(active.store.countRows('ingest_inbox')).toBe(0)
    const inbox = result.entries.find((entry) => entry.table === 'ingest_inbox')
    expect(inbox).toMatchObject({ outcome: 'deleted', rowsDeleted: 3, truncated: false })

    // One audit row per field per run: this run swept the inbox once.
    const ledger = active.store.listRetentionLedger({ fieldKey: 'ingest_inbox.envelope' })
    expect(ledger).toHaveLength(1)
    const last = ledger.at(-1)
    expect(last).toMatchObject({
      source: 'youtube_api',
      policy: 'delete',
      reason: 'scheduled',
      allowedPeriodDays: 30,
      outcome: 'deleted',
      rowsDeleted: 3,
      deadlineAt: null,
    })
    // The recorded cutoff proves nothing survived past its own deadline.
    expect(last?.cutoffAt).toBe(minusDays(active.clock.nowUtcIso(), 30))
    expect(last?.deletedAt).not.toBeNull()
    expect(last?.purpose).toContain('ingest inbox')
  })

  it('writes one audit row per field on every run, including the quiet ones', () => {
    const active = open()
    const result = sweeper(active).run()

    expect(result.entries).toHaveLength(active.config.fields.length)
    const recorded = active.store.listRetentionLedger().map((row) => row.fieldKey)
    for (const field of active.config.fields) {
      expect(recorded).toContain(field.key)
    }
  })

  it('expires every table that carries source data, not just the inbox', async () => {
    const active = open()
    const seqs = seedInbox(active.store, 1, T0)
    seedState(active.store, {
      at: T0,
      revision: 1,
      processedSeq: seqs[0] as number,
      processed: seqs,
      giftMessageId: 'msg_test_gift_0001',
      giftComboCount: 2,
    })
    insertBroadcastResource(active.temp.file, 'brd_test_old_0001', T0)

    for (const table of [
      'ingest_inbox',
      'source_checkpoint',
      'state_transitions',
      'deadlines',
      'effect_outbox',
      'paid_ledger',
      'gift_combo',
      'broadcast_resources',
    ]) {
      expect(active.store.countRows(table), `${table} seeded`).toBeGreaterThan(0)
    }

    await active.clock.advance(30 * DAY_MS + 1)
    const result = sweeper(active).run()

    for (const table of [
      'ingest_inbox',
      'source_checkpoint',
      'state_transitions',
      'deadlines',
      'effect_outbox',
      'paid_ledger',
      'gift_combo',
      'broadcast_resources',
    ]) {
      expect(active.store.countRows(table), `${table} swept`).toBe(0)
    }
    expect(result.failed).toEqual([])
    // The world snapshot is derived state with no source data in it, so it is
    // re-verified rather than deleted (spec §12.4, config/retention.json).
    expect(active.store.countRows('world_snapshot')).toBe(1)
  })

  it('never reuses an ingest sequence a deletion freed', async () => {
    const active = open()
    const first = seedInbox(active.store, 3, T0)
    await active.clock.advance(30 * DAY_MS + 1)
    sweeper(active).run()
    expect(active.store.countRows('ingest_inbox')).toBe(0)

    const next = seedInbox(active.store, 1, active.clock.nowUtcIso(), 'msg_test_after')
    // T4 made `ingest_seq` AUTOINCREMENT precisely so retention cannot hand a
    // recovery cursor a sequence that already meant something else.
    expect(next[0] as number).toBeGreaterThan(Math.max(...first))
  })

  it('counts deleted inbox rows the writer had never processed', async () => {
    const active = open()
    const seqs = seedInbox(active.store, 2, T0)
    seedState(active.store, {
      at: T0,
      revision: 1,
      processedSeq: seqs[0] as number,
      processed: [seqs[0] as number],
    })

    await active.clock.advance(30 * DAY_MS + 1)
    const result = sweeper(active).run()

    const inbox = result.entries.find((entry) => entry.table === 'ingest_inbox')
    expect(inbox?.rowsDeleted).toBe(2)
    expect(inbox?.rowsUnprocessed).toBe(1)
    expect(result.rowsUnprocessed).toBe(1)
    const ledger = active.store.listRetentionLedger({ fieldKey: 'ingest_inbox.envelope' }).at(-1)
    expect(ledger?.rowsUnprocessed).toBe(1)
  })

  it('keeps a gift maximum while its inbox rows are alive and drops it after', async () => {
    const active = open()
    active.store.commitIngestBatch([giftEnvelope('msg_test_gift_0001', T0, 2)], {
      sourceKey: TEST_SOURCE_KEY,
      liveChatId: TEST_LIVE_CHAT_ID,
      nextPageToken: null,
    })
    active.store.upsertGiftMax('youtube:brd_test_0001:msg_test_gift_0001', 2)
    expect(active.store.countRows('gift_combo')).toBe(1)

    // Still referenced by a live inbox row: the maximum must stay, otherwise a
    // replayed combo step would apply a second time (spec §7.4).
    await active.clock.advance(10 * DAY_MS)
    sweeper(active).run()
    expect(active.store.countRows('gift_combo')).toBe(1)

    await active.clock.advance(21 * DAY_MS)
    const result = sweeper(active).run()
    expect(active.store.countRows('ingest_inbox')).toBe(0)
    expect(active.store.countRows('gift_combo')).toBe(0)
    expect(result.entries.find((entry) => entry.table === 'gift_combo')?.outcome).toBe('deleted')
  })

  it('resumes across runs when the batch budget is exhausted', async () => {
    const active = open()
    seedInbox(active.store, 3, T0)
    await active.clock.advance(30 * DAY_MS + 1)

    const tiny: RetentionConfig = {
      ...active.config,
      sweep: { ...active.config.sweep, batchLimit: 1, maxBatchesPerEntry: 1 },
    }
    const first = new RetentionSweeper({
      store: active.store,
      clock: active.clock,
      config: tiny,
    }).run()

    expect(first.truncated).toContain('ingest_inbox.envelope')
    expect(first.clean).toBe(false)
    expect(active.store.countRows('ingest_inbox')).toBe(2)

    const second = sweeper(active).run()
    expect(second.truncated).toEqual([])
    expect(second.clean).toBe(true)
    expect(active.store.countRows('ingest_inbox')).toBe(0)
  })
})

describe('refresh policy (spec §12.4 30일마다 권한과 삭제 여부를 다시 확인)', () => {
  it('reports a field that was not rewritten inside its period', async () => {
    const active = open()
    seedState(active.store, { at: T0, revision: 1, processedSeq: 0 })

    await active.clock.advance(10 * DAY_MS)
    const fresh = sweeper(active).run()
    expect(fresh.entries.find((entry) => entry.table === 'world_snapshot')?.outcome).toBe(
      'reverified',
    )
    expect(fresh.reverificationDue).toEqual([])

    await active.clock.advance(21 * DAY_MS)
    const stale = sweeper(active).run()
    expect(stale.entries.find((entry) => entry.table === 'world_snapshot')?.outcome).toBe(
      'reverification_due',
    )
    expect(stale.reverificationDue).toEqual(['world_snapshot.snapshot'])
    expect(stale.clean).toBe(false)
    // Reported, not deleted: the renderer recovers from this row.
    expect(active.store.countRows('world_snapshot')).toBe(1)
  })

  it('deletes a stale refresh field when the verifier says permission is gone', async () => {
    const active = open()
    seedState(active.store, { at: T0, revision: 1, processedSeq: 0 })
    await active.clock.advance(31 * DAY_MS)

    const result = sweeper(active, { reverify: () => 'delete' }).run()
    expect(result.entries.find((entry) => entry.table === 'world_snapshot')?.outcome).toBe(
      'deleted',
    )
    expect(active.store.countRows('world_snapshot')).toBe(0)
  })

  it('accepts a verifier that confirms the field is still authorized', async () => {
    const active = open()
    seedState(active.store, { at: T0, revision: 1, processedSeq: 0 })
    await active.clock.advance(31 * DAY_MS)

    const result = sweeper(active, { reverify: () => 'still_authorized' }).run()
    expect(result.entries.find((entry) => entry.table === 'world_snapshot')?.outcome).toBe(
      'reverified',
    )
    expect(result.reverificationDue).toEqual([])
    expect(active.store.countRows('world_snapshot')).toBe(1)
  })

  it('records a planned table as absent instead of failing the sweep', () => {
    const active = open()
    const planned = active.config.fields.filter((field) => field.status === 'planned')
    expect(planned.length).toBeGreaterThan(0)

    const result = sweeper(active).run()
    for (const field of planned) {
      expect(result.entries.find((entry) => entry.fieldKey === field.key)?.outcome).toBe(
        'table_absent',
      )
    }
    expect(result.failed).toEqual([])
  })
})

describe('retention_ledger constraints (migration 002)', () => {
  const base = {
    fieldKey: 'ingest_inbox.envelope',
    source: 'youtube_api',
    purpose: 'test',
    policy: 'delete',
    reason: 'scheduled',
    allowedPeriodDays: 30,
    cutoffAt: T0,
    deadlineAt: null,
    recordedAt: T0,
  } as const

  it('accepts a well-formed scheduled deletion row', () => {
    const active = open()
    expect(
      active.store.recordRetention({
        ...base,
        outcome: 'deleted',
        rowsDeleted: 2,
        deletedAt: T0,
      }),
    ).toBeGreaterThan(0)
  })

  it('refuses a deletion that claims no rows or no instant', () => {
    const active = open()
    expect(() =>
      active.store.recordRetention({ ...base, outcome: 'deleted', rowsDeleted: 0, deletedAt: T0 }),
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      active.store.recordRetention({ ...base, outcome: 'deleted', rowsDeleted: 2 }),
    ).toThrow(/CHECK constraint failed/)
  })

  it('refuses a non-deletion outcome that claims rows', () => {
    const active = open()
    expect(() =>
      active.store.recordRetention({ ...base, outcome: 'nothing_expired', rowsDeleted: 1 }),
    ).toThrow(/CHECK constraint failed/)
  })

  it('refuses more unprocessed rows than deleted rows', () => {
    const active = open()
    expect(() =>
      active.store.recordRetention({
        ...base,
        outcome: 'deleted',
        rowsDeleted: 1,
        rowsUnprocessed: 2,
        deletedAt: T0,
      }),
    ).toThrow(/CHECK constraint failed/)
  })

  it('refuses a scheduled row with a deadline, or a triggered row with a cutoff', () => {
    const active = open()
    expect(() =>
      active.store.recordRetention({ ...base, outcome: 'nothing_expired', deadlineAt: T0 }),
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      active.store.recordRetention({
        ...base,
        reason: 'consent_revoked',
        outcome: 'nothing_expired',
        deadlineAt: T0,
      }),
    ).toThrow(/CHECK constraint failed/)
  })
})

describe('schema coverage', () => {
  it('refuses to run when a table has no declared retention policy', () => {
    const active = open()
    const database = openDatabase({ file: active.temp.file, busyTimeoutMs: 1000 })
    try {
      database.exec('CREATE TABLE undeclared_table (id TEXT PRIMARY KEY) STRICT')
    } finally {
      database.close()
    }

    expect(() => sweeper(active)).toThrow(RetentionConfigError)
    expect(() => sweeper(active)).toThrow(/undeclared_table/)
  })
})
