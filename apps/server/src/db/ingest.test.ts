import { afterEach, describe, expect, it } from 'vitest'

import type { Clock, TimerHandle } from '../clock.js'
import { PersistenceInvariantError } from './errors.js'
import { openDatabase } from './open.js'
import { checkpointInput, grpcEnvelope, TEST_SOURCE_KEY } from './testing/fixtures.js'
import { createTempStore, TEST_BUSY_TIMEOUT_MS, type TempStore } from './testing/temp-store.js'

/**
 * `commitIngestBatch` and the recovery drain (spec §7.3(2)(3)(4)).
 */

let temp: TempStore | undefined

afterEach(() => {
  temp?.dispose()
  temp = undefined
})

function open(clock?: Clock): TempStore {
  temp = createTempStore(clock === undefined ? {} : { clock })
  return temp
}

/**
 * A clock that raises on the next reading once armed.
 *
 * `commitIngestBatch` reads the clock exactly once — for the checkpoint, *after*
 * the inbox rows are written — so arming it injects an exception into the crash
 * window "inbox insert 뒤 / checkpoint 전" (TASK_SPECS §T4 합격 기준 1).
 */
class ArmableClock implements Clock {
  failNextReading = false
  #readings = 0
  nowUtcIso(): string {
    if (this.failNextReading) {
      this.failNextReading = false
      throw new Error('injected clock failure')
    }
    this.#readings += 1
    return new Date(Date.UTC(2026, 7, 16, 0, this.#readings)).toISOString()
  }
  monotonicMs(): number {
    return this.#readings
  }
  setTimeout(): TimerHandle {
    throw new Error('not used')
  }
  clearTimeout(): void {
    throw new Error('not used')
  }
}

describe('commitIngestBatch', () => {
  it('writes every envelope of one response and the checkpoint together', () => {
    const { store } = open()
    const envelopes = [
      grpcEnvelope('text-message-event'),
      grpcEnvelope('super-chat-event'),
      grpcEnvelope('unsupported-chat-ended-event'),
      grpcEnvelope('invalid-missing-id'),
    ]

    const result = store.commitIngestBatch(envelopes, checkpointInput('token_page_2'))

    expect(result.insertedCount).toBe(4)
    expect(result.duplicateCount).toBe(0)
    expect(result.results.map((row) => row.ingestSeq)).toEqual([1, 2, 3, 4])
    expect(result.checkpoint.nextPageToken).toBe('token_page_2')
    expect(result.checkpoint.lastIngestSeq).toBe(4)
    expect(store.getSourceCheckpoint(TEST_SOURCE_KEY)?.lastIngestSeq).toBe(4)
  })

  it('keeps a poison item from stalling the checkpoint (spec §7.3(2))', () => {
    const { store } = open()
    // Only unsupported and invalid items in the response: the token must still
    // advance, otherwise the listener re-reads the same page forever.
    const result = store.commitIngestBatch(
      [grpcEnvelope('unsupported-user-banned-event'), grpcEnvelope('invalid-malformed-amount')],
      checkpointInput('token_after_poison'),
    )
    expect(result.results.map((row) => row.duplicate)).toEqual([false, false])
    expect(store.drainUnprocessed(0, 10).map((row) => row.validationStatus)).toEqual([
      'unsupported',
      'invalid',
    ])
    expect(store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_after_poison')
  })

  it('advances the checkpoint for an empty response', () => {
    const { store } = open()
    const result = store.commitIngestBatch([], checkpointInput('token_empty_page'))
    expect(result.insertedCount).toBe(0)
    expect(result.checkpoint.nextPageToken).toBe('token_empty_page')
    expect(result.checkpoint.lastIngestSeq).toBe(0)
  })

  it('stores the same message once and reports the second as a duplicate', () => {
    const { store } = open()
    const envelope = grpcEnvelope('text-message-event')

    const first = store.commitIngestBatch([envelope], checkpointInput('token_1'))
    const second = store.commitIngestBatch([envelope], checkpointInput('token_2'))

    expect(first.results[0]).toEqual({
      ingestSeq: 1,
      messageId: 'msg_test_0001',
      duplicate: false,
    })
    expect(second.results[0]).toEqual({
      ingestSeq: 1,
      messageId: 'msg_test_0001',
      duplicate: true,
    })
    expect(second.duplicateCount).toBe(1)

    const rows = store.drainUnprocessed(0, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ingestSeq).toBe(1)
    // The replayed batch must not rewind the sequence the drain resumes from.
    expect(second.checkpoint.lastIngestSeq).toBe(1)
    expect(second.checkpoint.nextPageToken).toBe('token_2')
  })

  it('deduplicates a duplicate inside a single batch', () => {
    const { store } = open()
    const envelope = grpcEnvelope('text-message-event')
    const result = store.commitIngestBatch([envelope, envelope], checkpointInput())
    expect(result.insertedCount).toBe(1)
    expect(result.duplicateCount).toBe(1)
    expect(store.drainUnprocessed(0, 10)).toHaveLength(1)
  })

  it('treats each gift combo step as its own row (spec §7.4)', () => {
    const { store } = open()
    // Same message id, growing combo count: the effective count is part of the
    // event key, so these are four idempotency units, not one duplicate.
    const result = store.commitIngestBatch(
      [
        grpcEnvelope('gift-event-combo-0'),
        grpcEnvelope('gift-event-combo-1'),
        grpcEnvelope('gift-event-combo-3'),
        grpcEnvelope('gift-event-combo-5'),
      ],
      checkpointInput(),
    )
    // combo 0 and combo 1 both normalize to effectiveCount 1, so they are the
    // same key: three rows, one duplicate.
    expect(result.insertedCount).toBe(3)
    expect(result.duplicateCount).toBe(1)
    expect(result.results.map((row) => row.duplicate)).toEqual([false, true, false, false])
  })

  it('never deduplicates items that carry no message id', () => {
    const { store } = open()
    const envelope = grpcEnvelope('invalid-missing-id')
    const result = store.commitIngestBatch([envelope, envelope], checkpointInput())
    // Two malformed items without ids are two observations; inventing an
    // identity for them would be the wrong kind of guess (spec §7.3(1)).
    expect(result.insertedCount).toBe(2)
    expect(result.duplicateCount).toBe(0)
  })

  it('rejects a checkpoint without a source key and writes nothing', () => {
    const { store } = open()
    expect(() =>
      store.commitIngestBatch([grpcEnvelope('text-message-event')], {
        sourceKey: '',
        liveChatId: 'chat_test_0001',
        nextPageToken: null,
      }),
    ).toThrow(PersistenceInvariantError)
    expect(store.drainUnprocessed(0, 10)).toEqual([])
  })

  it('rejects an envelope that is not contract-shaped and writes nothing', () => {
    const { store } = open()
    const broken = { ...grpcEnvelope('text-message-event'), receivedAt: 'yesterday' }
    expect(() =>
      store.commitIngestBatch([broken as ReturnType<typeof grpcEnvelope>], checkpointInput()),
    ).toThrow()
    expect(store.drainUnprocessed(0, 10)).toEqual([])
    expect(store.getSourceCheckpoint(TEST_SOURCE_KEY)).toBeNull()
  })

  it('crash window "after inbox insert, before checkpoint" leaves no partial commit', () => {
    const clock = new ArmableClock()
    const { store } = open(clock)
    clock.failNextReading = true

    expect(() =>
      store.commitIngestBatch(
        [grpcEnvelope('text-message-event'), grpcEnvelope('super-chat-event')],
        checkpointInput('token_never_stored'),
      ),
    ).toThrow(/injected clock failure/)

    expect(store.drainUnprocessed(0, 10)).toEqual([])
    expect(store.getSourceCheckpoint(TEST_SOURCE_KEY)).toBeNull()
  })

  it('reuses no ingest_seq after rows are deleted (AUTOINCREMENT)', () => {
    const handle = open()
    handle.store.commitIngestBatch(
      [grpcEnvelope('text-message-event'), grpcEnvelope('super-chat-event')],
      checkpointInput(),
    )

    // T13 deletes expired inbox rows; the delete itself is out of scope here, so
    // the test does it directly. AUTOINCREMENT is what keeps `processedIngestSeq`
    // comparisons sound afterwards: "The purpose of AUTOINCREMENT is to prevent
    // the reuse of ROWIDs from previously deleted rows."
    // https://sqlite.org/autoinc.html (2026-08-17)
    const raw = openDatabase({ file: handle.file, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS })
    try {
      raw.prepare('DELETE FROM ingest_inbox').run()
    } finally {
      raw.close()
    }

    const result = handle.store.commitIngestBatch(
      [grpcEnvelope('gift-event-combo-3')],
      checkpointInput(),
    )
    expect(result.results[0]?.ingestSeq).toBe(3)
  })
})

describe('drainUnprocessed', () => {
  it('returns unprocessed rows after the sequence, in order, up to the limit', () => {
    const { store } = open()
    store.commitIngestBatch(
      [
        grpcEnvelope('text-message-event'),
        grpcEnvelope('text-message-event-noise'),
        grpcEnvelope('super-chat-event'),
      ],
      checkpointInput(),
    )

    expect(store.drainUnprocessed(0, 2).map((row) => row.ingestSeq)).toEqual([1, 2])
    expect(store.drainUnprocessed(2, 10).map((row) => row.ingestSeq)).toEqual([3])
    expect(store.drainUnprocessed(3, 10)).toEqual([])
  })

  it('returns the stored envelope unchanged', () => {
    const { store } = open()
    const envelope = grpcEnvelope('super-chat-event')
    store.commitIngestBatch([envelope], checkpointInput())
    expect(store.drainUnprocessed(0, 10)[0]?.envelope).toEqual(envelope)
  })

  it('rejects a non-positive limit and a negative sequence', () => {
    const { store } = open()
    expect(() => store.drainUnprocessed(0, 0)).toThrow(PersistenceInvariantError)
    expect(() => store.drainUnprocessed(-1, 10)).toThrow(PersistenceInvariantError)
  })
})
