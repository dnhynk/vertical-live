import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/index.js'
import {
  IdentityColumnsPresentError,
  USER_DELETION_FIELD_KEY,
  UserDeletionRequestHandler,
} from './deletion-request.js'
import { plusDays } from './retention.js'
import { createRetentionHarness, seedInbox, type RetentionHarness } from './testing/harness.js'

/**
 * User / account deletion requests (spec §12.4: "사용자 삭제·계정 삭제 요청은 해당
 * 사용자와 관련해 저장한 모든 user data를 가능한 빨리, 최대 7일 안에 삭제한다").
 *
 * Two answers, both of which have to be provable rather than merely returned:
 * a request naming nobody the system stored is answered from the live schema
 * with a dated record, and a request naming a consented viewer (BOARD D-9)
 * deletes their one `viewer_consent` row immediately and records that.
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

function handlerFor(active: RetentionHarness): UserDeletionRequestHandler {
  return new UserDeletionRequestHandler({
    store: active.store,
    clock: active.clock,
    config: active.config,
  })
}

describe('user deletion request handler', () => {
  it('confirms no identifier is stored and records the request', () => {
    const active = open()
    seedInbox(active.store, 2, T0)

    const receipt = handlerFor(active).handle(undefined, T0)

    expect(receipt.storedIdentifierColumns).toEqual([])
    expect(receipt.rowsDeleted).toBe(0)
    expect(receipt.deadlineAt).toBe(plusDays(T0, 7))

    const rows = active.store.listRetentionLedger({ reason: 'user_request' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      fieldKey: USER_DELETION_FIELD_KEY,
      policy: 'delete',
      reason: 'user_request',
      allowedPeriodDays: 7,
      outcome: 'no_stored_identifiers',
      rowsDeleted: 0,
      deletedAt: null,
      cutoffAt: null,
      deadlineAt: plusDays(T0, 7),
    })
    // Nothing else is touched: the inbox rows are not this person's data, they
    // are identifier-free events that expire on their own schedule.
    expect(active.store.countRows('ingest_inbox')).toBe(2)
  })

  it('defaults the receipt instant to the injected clock', () => {
    const active = open()
    const receipt = handlerFor(active).handle()
    expect(receipt.receivedAt).toBe(active.clock.nowUtcIso())
    expect(receipt.deadlineAt).toBe(plusDays(active.clock.nowUtcIso(), 7))
  })

  it('records each request separately so an audit can count them', () => {
    const active = open()
    const handler = handlerFor(active)
    handler.handle(undefined, T0)
    handler.handle(undefined, T0)
    expect(active.store.listRetentionLedger({ reason: 'user_request' })).toHaveLength(2)
  })

  it('deletes the consented viewer named by the request (BOARD D-9)', () => {
    const active = open()
    const stored = active.store.upsertConsent({
      channelRef: 'ref_00000000000000000000000000000001',
      channelId: 'UC_TEST_synthetic_viewer_1',
      displayName: 'synthetic-viewer-1',
      consentedAt: T0,
      lastActiveAt: T0,
      noticeVersion: '2026-08-19',
    })

    const receipt = handlerFor(active).handle({ channelRef: stored.channelRef }, T0)

    expect(receipt.rowsDeleted).toBe(1)
    expect(active.store.findConsentByChannelRef(stored.channelRef)).toBeNull()
    expect(active.store.countRows('viewer_consent')).toBe(0)
    const rows = active.store.listRetentionLedger({ reason: 'user_request' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      fieldKey: 'viewer_consent.identity',
      outcome: 'deleted',
      rowsDeleted: 1,
      deadlineAt: plusDays(T0, 7),
    })
    expect(rows[0]?.deletedAt).not.toBeNull()
  })

  it('records a deletion request for a viewer who was never stored', () => {
    // The honest answer to "delete my data" from somebody who never opted in:
    // nothing was deleted, and the record says so instead of claiming a row.
    const active = open()
    const receipt = handlerFor(active).handle({ channelId: 'UC_TEST_synthetic_viewer_absent' }, T0)
    expect(receipt.rowsDeleted).toBe(0)
    expect(active.store.listRetentionLedger({ reason: 'user_request' })[0]).toMatchObject({
      outcome: 'no_stored_identifiers',
      rowsDeleted: 0,
      deletedAt: null,
    })
  })

  it('never writes the subject into the ledger or a log line', () => {
    const active = open()
    const lines: string[] = []
    const handler = new UserDeletionRequestHandler({
      store: active.store,
      clock: active.clock,
      config: active.config,
      logger: {
        debug: (message, fields) => lines.push(`${message} ${JSON.stringify(fields)}`),
        info: (message, fields) => lines.push(`${message} ${JSON.stringify(fields)}`),
        warn: (message, fields) => lines.push(`${message} ${JSON.stringify(fields)}`),
        error: (message, fields) => lines.push(`${message} ${JSON.stringify(fields)}`),
      },
    })
    active.store.upsertConsent({
      channelRef: 'ref_00000000000000000000000000000002',
      channelId: 'UC_TEST_synthetic_viewer_2',
      displayName: 'synthetic-viewer-2',
      consentedAt: T0,
      lastActiveAt: T0,
      noticeVersion: '2026-08-19',
    })

    handler.handle({ channelId: 'UC_TEST_synthetic_viewer_2' }, T0)

    const ledger = JSON.stringify(active.store.listRetentionLedger({ reason: 'user_request' }))
    for (const haystack of [ledger, lines.join('\n')]) {
      expect(haystack).not.toContain('UC_TEST_synthetic_viewer_2')
      expect(haystack).not.toContain('synthetic-viewer-2')
      expect(haystack).not.toContain('ref_00000000000000000000000000000002')
    }
  })

  it('refuses to answer once a table other than viewer_consent can store an identifier', () => {
    // Recording "deleted everything" against a schema that has a *second* place
    // to store a person would be a false audit record, so the handler fails
    // loudly instead (spec §12.4; the consent table itself is the one exception,
    // BOARD D-9).
    const active = open()
    const database = openDatabase({ file: active.temp.file, busyTimeoutMs: 1000 })
    try {
      database.exec('CREATE TABLE viewer_identity (author_channel_id TEXT PRIMARY KEY) STRICT')
    } finally {
      database.close()
    }

    const handler = handlerFor(active)
    expect(() => handler.handle(undefined, T0)).toThrow(IdentityColumnsPresentError)
    expect(() => handler.handle(undefined, T0)).toThrow(/viewer_identity.author_channel_id/)
    expect(active.store.listRetentionLedger({ reason: 'user_request' })).toEqual([])
  })
})
