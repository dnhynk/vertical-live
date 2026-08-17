import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/index.js'
import { InMemorySecretVault } from '../secrets/memory.js'
import { REFRESH_TOKEN_SECRET } from '../youtube/auth/token-manager.js'
import type { AuthRevokedEvent, AuthRevokedReason } from '../youtube/auth/events.js'
import { plusDays } from './retention.js'
import {
  RevocationAuthEventSink,
  RevocationHandler,
  vaultGrantRevoker,
  type GrantRevokeOutcome,
  type GrantRevoker,
} from './revocation.js'
import {
  DAY_MS,
  createRetentionHarness,
  insertBroadcastResource,
  seedInbox,
  seedState,
  type RetentionHarness,
} from './testing/harness.js'

/**
 * TASK_SPECS §T13 acceptance 1, revocation half (spec §12.4):
 *
 * - client-side withdrawal: token revoked and Authorized Data deleted inside 7 days
 * - revocation observed at the provider: the separate 30-day rule applies
 *
 * The deletion runs at once in both branches; what the branch changes is the
 * deadline the ledger records, so an audit can tell which window applied.
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

/** Both sink callbacks are required, so tests that ignore one still pass it. */
function noop(): void {
  // intentionally empty
}

/** Records that it ran; the vault-backed revoker is covered separately. */
function fakeRevoker(outcome: GrantRevokeOutcome = 'erased'): GrantRevoker & { calls: number } {
  const revoker = {
    calls: 0,
    revoke: async (): Promise<GrantRevokeOutcome> => {
      revoker.calls += 1
      return Promise.resolve(outcome)
    },
  }
  return revoker
}

function handlerFor(active: RetentionHarness, revoker: GrantRevoker): RevocationHandler {
  return new RevocationHandler({
    store: active.store,
    clock: active.clock,
    config: active.config,
    grantRevoker: revoker,
  })
}

function revokedEvent(reason: AuthRevokedReason, at: string = T0): AuthRevokedEvent {
  return { type: 'auth_revoked', at, reason }
}

function seedAuthorizedData(active: RetentionHarness): void {
  const seqs = seedInbox(active.store, 2, T0)
  seedState(active.store, {
    at: T0,
    revision: 1,
    processedSeq: seqs[0] as number,
    processed: [seqs[0] as number],
    giftMessageId: 'msg_test_gift_0001',
    giftComboCount: 3,
  })
  insertBroadcastResource(active.temp.file, 'brd_test_live_0001', T0)
}

const AUTHORIZED_TABLES = [
  'ingest_inbox',
  'source_checkpoint',
  'state_transitions',
  'effect_outbox',
  'paid_ledger',
  'gift_combo',
  'broadcast_resources',
]

describe('consent withdrawal on this host (client-side, 7 days)', () => {
  it('leaves no usable grant and deletes the authorized data inside the window', async () => {
    const active = open()
    seedAuthorizedData(active)
    for (const table of AUTHORIZED_TABLES) {
      expect(active.store.countRows(table), `${table} seeded`).toBeGreaterThan(0)
    }

    const revoker = fakeRevoker()
    const result = await handlerFor(active, revoker).handle(revokedEvent('operator_revoked'))

    expect(revoker.calls).toBe(1)
    expect(result.revocationClass).toBe('client_side')
    expect(result.allowedPeriodDays).toBe(7)
    expect(result.deadlineAt).toBe(plusDays(T0, 7))
    expect(result.withinDeadline).toBe(true)
    expect(result.incomplete).toEqual([])
    expect(result.rowsDeleted).toBeGreaterThan(0)

    for (const table of AUTHORIZED_TABLES) {
      expect(active.store.countRows(table), `${table} deleted`).toBe(0)
    }
    // Derived state with no source data in it stays: deleting it would destroy
    // the world the renderer recovers from (spec §12.4, config/retention.json).
    expect(active.store.countRows('world_snapshot')).toBe(1)
  })

  it('records every deletion against the 7-day deadline', async () => {
    const active = open()
    seedAuthorizedData(active)
    await handlerFor(active, fakeRevoker()).handle(revokedEvent('operator_revoked'))

    const rows = active.store.listRetentionLedger({ reason: 'consent_revoked' })
    expect(rows).toHaveLength(
      active.config.fields.filter(
        (field) => field.dataClass === 'authorized_api_data' && field.status === 'present',
      ).length,
    )
    for (const row of rows) {
      expect(row.policy).toBe('delete')
      expect(row.allowedPeriodDays).toBe(7)
      expect(row.deadlineAt).toBe(plusDays(T0, 7))
      // A revocation deletes regardless of age, so there is no cutoff to record.
      expect(row.cutoffAt).toBeNull()
      if (row.outcome === 'deleted') {
        expect(row.deletedAt).not.toBeNull()
        expect(row.deletedAt! <= plusDays(T0, 7)).toBe(true)
      }
    }
    expect(rows.some((row) => row.outcome === 'deleted')).toBe(true)
  })

  it('treats a missing refresh token as the same client-side window', async () => {
    const active = open()
    seedAuthorizedData(active)
    const result = await handlerFor(active, fakeRevoker('nothing_stored')).handle(
      revokedEvent('missing_refresh_token'),
    )

    expect(result.revocationClass).toBe('client_side')
    expect(result.allowedPeriodDays).toBe(7)
    expect(result.grantOutcome).toBe('nothing_stored')
    expect(active.store.countRows('ingest_inbox')).toBe(0)
  })

  it('is idempotent: a second revocation deletes nothing and still records', async () => {
    const active = open()
    seedAuthorizedData(active)
    const handler = handlerFor(active, fakeRevoker())
    await handler.handle(revokedEvent('operator_revoked'))
    const second = await handler.handle(revokedEvent('operator_revoked'))

    expect(second.rowsDeleted).toBe(0)
    expect(second.entries.every((entry) => entry.outcome === 'nothing_expired')).toBe(true)
    expect(active.store.listRetentionLedger({ reason: 'consent_revoked' }).length).toBe(
      second.entries.length * 2,
    )
  })
})

describe('revocation observed at the provider (30 days)', () => {
  it('applies the separate 30-day rule to an invalid_grant', async () => {
    const active = open()
    seedAuthorizedData(active)
    const result = await handlerFor(active, fakeRevoker()).handle(revokedEvent('invalid_grant'))

    expect(result.revocationClass).toBe('provider_side')
    expect(result.allowedPeriodDays).toBe(30)
    expect(result.deadlineAt).toBe(plusDays(T0, 30))
    expect(active.store.countRows('ingest_inbox')).toBe(0)

    const rows = active.store.listRetentionLedger({ reason: 'provider_revoked' })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.allowedPeriodDays).toBe(30)
    expect(active.store.listRetentionLedger({ reason: 'consent_revoked' })).toEqual([])
  })

  it('reports a deletion that finished after the deadline', async () => {
    const active = open()
    seedAuthorizedData(active)
    // The event is dated 31 days before the clock: a deletion that only runs now
    // is late, and the result has to say so rather than round it away.
    const late = new Date(Date.parse(active.clock.nowUtcIso()) - 31 * DAY_MS).toISOString()
    const result = await handlerFor(active, fakeRevoker()).handle(
      revokedEvent('invalid_grant', late),
    )

    expect(result.deadlineAt).toBe(plusDays(late, 30))
    expect(result.completedAt > result.deadlineAt).toBe(true)
    expect(result.withinDeadline).toBe(false)
  })
})

describe('revocation deletion and its audit row are atomic', () => {
  it('keeps the authorized data when the audit row cannot be written', async () => {
    // Review round 1, B1, on the revocation path: a 7-day deletion obligation
    // whose evidence cannot be written must not delete the data either.
    const active = open()
    seedAuthorizedData(active)
    const database = openDatabase({ file: active.temp.file, busyTimeoutMs: 1000 })
    try {
      database.exec(
        `CREATE TRIGGER retention_ledger_block BEFORE INSERT ON retention_ledger
         BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END`,
      )
    } finally {
      database.close()
    }

    await expect(
      handlerFor(active, fakeRevoker()).handle(revokedEvent('operator_revoked')),
    ).rejects.toThrow(/ledger unavailable/)
    for (const table of AUTHORIZED_TABLES) {
      expect(active.store.countRows(table), `${table} kept`).toBeGreaterThan(0)
    }
    expect(active.store.countRows('retention_ledger')).toBe(0)
  })

  it('records one audit row per batch of a multi-batch revocation', async () => {
    const active = open()
    seedInbox(active.store, 3, T0)
    const oneAtATime = {
      ...active.config,
      sweep: { ...active.config.sweep, batchLimit: 1, maxBatchesPerEntry: 10 },
    }
    const result = await new RevocationHandler({
      store: active.store,
      clock: active.clock,
      config: oneAtATime,
      grantRevoker: fakeRevoker(),
    }).handle(revokedEvent('operator_revoked'))

    const inbox = result.entries.find((entry) => entry.table === 'ingest_inbox')
    expect(inbox?.rowsDeleted).toBe(3)
    expect(inbox?.ledgerEntryIds).toHaveLength(3)
    const rows = active.store.listRetentionLedger({ fieldKey: 'ingest_inbox.envelope' })
    expect(rows.map((row) => row.rowsDeleted)).toEqual([1, 1, 1])
    for (const row of rows) {
      expect(row.reason).toBe('consent_revoked')
      expect(row.deadlineAt).toBe(plusDays(T0, 7))
      expect(row.deletedAt).not.toBeNull()
    }
    expect(active.store.countRows('ingest_inbox')).toBe(0)
  })
})

describe('vaultGrantRevoker', () => {
  it('removes the stored refresh token and reports what it found', async () => {
    const vault = new InMemorySecretVault()
    await vault.set(REFRESH_TOKEN_SECRET, 'synthetic-refresh-token-value')
    const revoker = vaultGrantRevoker(vault)

    expect(await revoker.revoke()).toBe('erased')
    expect(await vault.get(REFRESH_TOKEN_SECRET)).toBeUndefined()
    // Idempotent: the second call has nothing left to remove.
    expect(await revoker.revoke()).toBe('nothing_stored')
  })
})

describe('RevocationAuthEventSink', () => {
  it('runs the handler for auth_revoked and ignores every other auth event', async () => {
    const active = open()
    seedAuthorizedData(active)
    const results: string[] = []
    const sink = new RevocationAuthEventSink({
      handler: handlerFor(active, fakeRevoker()),
      onResult: (result) => results.push(result.revocationClass),
      onError: noop,
    })

    sink.emit({ type: 'auth_token_refreshed', at: T0, accessTokenExpiresAt: T0 })
    await sink.pending
    expect(results).toEqual([])
    expect(active.store.countRows('ingest_inbox')).toBeGreaterThan(0)

    sink.emit(revokedEvent('operator_revoked'))
    await sink.pending
    expect(results).toEqual(['client_side'])
    expect(active.store.countRows('ingest_inbox')).toBe(0)
    expect(sink.failed).toBe(false)
  })

  it('reports a failing deletion instead of dropping the obligation', async () => {
    const active = open()
    const errors: unknown[] = []
    const sink = new RevocationAuthEventSink({
      handler: handlerFor(active, {
        revoke: () => Promise.reject(new Error('vault unavailable')),
      }),
      onResult: noop,
      onError: (error) => errors.push(error),
    })

    sink.emit(revokedEvent('operator_revoked'))
    await sink.pending
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('vault unavailable')
    // Also observable in state, so a caller whose own sink throws cannot erase it.
    expect(sink.failed).toBe(true)
    expect(sink.failures).toHaveLength(1)
    expect(sink.failures[0]?.reason).toBe('operator_revoked')
  })

  it('refuses to be constructed without a result or error sink', () => {
    // Review round 1, B2: the previous optional `onError` defaulted to an empty
    // function, so a rejected revocation resolved `pending` and vanished.
    const active = open()
    const handler = handlerFor(active, fakeRevoker())
    expect(() => new RevocationAuthEventSink({ handler, onResult: noop } as never)).toThrow(
      /onError is required/,
    )
    expect(() => new RevocationAuthEventSink({ handler, onError: noop } as never)).toThrow(
      /onResult is required/,
    )
    expect(
      () => new RevocationAuthEventSink({ handler, onResult: noop, onError: null } as never),
    ).toThrow(TypeError)
  })

  it('keeps recording failures when the error sink itself throws', async () => {
    const active = open()
    const sink = new RevocationAuthEventSink({
      handler: handlerFor(active, {
        revoke: () => Promise.reject(new Error('vault unavailable')),
      }),
      onResult: noop,
      onError: () => {
        throw new Error('alerting is broken too')
      },
    })

    sink.emit(revokedEvent('operator_revoked'))
    await sink.pending.catch(() => undefined)
    expect(sink.failed).toBe(true)
    expect((sink.failures[0]?.error as Error).message).toBe('vault unavailable')
  })
})
