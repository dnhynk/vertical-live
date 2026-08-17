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
 * While the identity gate is closed the answer is "nothing about a person is
 * stored" — and the handler has to *prove* that from the live schema and leave a
 * dated record, not simply return success.
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

    const receipt = handlerFor(active).handle(T0)

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
    handler.handle(T0)
    handler.handle(T0)
    expect(active.store.listRetentionLedger({ reason: 'user_request' })).toHaveLength(2)
  })

  it('refuses to answer once the schema can store an identifier', () => {
    // The interface a future identity gate has to replace: recording "nothing
    // stored" against a schema that *can* store a person would be a false audit
    // record, so the handler fails loudly instead (spec §12.4, §17).
    const active = open()
    const database = openDatabase({ file: active.temp.file, busyTimeoutMs: 1000 })
    try {
      database.exec('CREATE TABLE viewer_identity (author_channel_id TEXT PRIMARY KEY) STRICT')
    } finally {
      database.close()
    }

    const handler = handlerFor(active)
    expect(() => handler.handle(T0)).toThrow(IdentityColumnsPresentError)
    expect(() => handler.handle(T0)).toThrow(/viewer_identity.author_channel_id/)
    expect(active.store.listRetentionLedger({ reason: 'user_request' })).toEqual([])
  })
})
