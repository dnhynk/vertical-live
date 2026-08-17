import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import {
  TEST_BROADCAST_ID,
  TEST_LIVE_CHAT_ID,
  TEST_SOURCE_KEY,
  grpcFixture,
  restFixture,
  storeInbox,
  testParseCommand,
} from '../../testing/chat-test-support.js'
import { ChatIngestSink, normalizeChatItems, type ChatItemAdapter } from './sink.js'

/**
 * Spec §7.3(2): every envelope of one response *and* the reconnect token in one
 * transaction, and a poison item never stalls the checkpoint.
 */

describe('ChatIngestSink', () => {
  let temp: TempStore

  beforeEach(() => {
    temp = createTempStore()
  })

  afterEach(() => {
    temp.dispose()
  })

  function sink(initialPageToken: string | null = null): ChatIngestSink {
    return new ChatIngestSink({
      inbox: storeInbox(temp.store),
      clock: temp.clock,
      parseCommand: testParseCommand,
      sourceKey: TEST_SOURCE_KEY,
      liveChatId: TEST_LIVE_CHAT_ID,
      broadcastId: TEST_BROADCAST_ID,
      initialPageToken,
    })
  }

  it('commits gRPC items and the reconnect token together', () => {
    const outcome = sink().commit({
      sourceShape: 'grpc',
      items: [grpcFixture('text-message-event'), grpcFixture('super-chat-event')],
      nextPageToken: 'token_test_1',
    })

    expect(outcome.accepted).toBe(2)
    expect(outcome.inserted).toBe(2)
    expect(outcome.dropped).toBe(0)
    expect(outcome.userEvents).toBe(2)
    expect(outcome.checkpoint.nextPageToken).toBe('token_test_1')
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_test_1')
    expect(temp.store.drainUnprocessed(0, 10)).toHaveLength(2)
  })

  it('normalizes REST items with the REST adapter', () => {
    const outcome = sink().commit({
      sourceShape: 'rest',
      items: [restFixture('text-message-event')],
      nextPageToken: 'token_test_rest',
    })

    expect(outcome.inserted).toBe(1)
    const [row] = temp.store.drainUnprocessed(0, 10)
    expect(row?.envelope.sourceShape).toBe('rest')
    expect(row?.envelope.validationStatus).toBe('valid')
  })

  it('keeps an unsupported or malformed item as a minimal envelope and still advances', () => {
    const outcome = sink().commit({
      sourceShape: 'grpc',
      items: [
        grpcFixture('unsupported-chat-ended-event'),
        grpcFixture('invalid-missing-published-at'),
        grpcFixture('text-message-event'),
      ],
      nextPageToken: 'token_test_2',
    })

    expect(outcome.accepted).toBe(3)
    expect(outcome.dropped).toBe(0)
    // Only the text message is a user event; the other two are recorded but not
    // counted as participation (spec §7.3(1)).
    expect(outcome.userEvents).toBe(1)
    const statuses = temp.store.drainUnprocessed(0, 10).map((row) => row.envelope.validationStatus)
    expect(statuses).toEqual(['unsupported', 'invalid', 'valid'])
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_test_2')
  })

  it('drops an item whose adapter throws and still commits the rest', () => {
    // A property that throws on read is the only way to make the real adapter
    // throw — which is the point: the guard exists for the bug that should not
    // happen, and a frozen checkpoint would be the worse failure.
    const hostile = {
      get id(): string {
        throw new Error('adapter bug')
      },
    }
    const outcome = sink().commit({
      sourceShape: 'grpc',
      items: [hostile, grpcFixture('text-message-event')],
      nextPageToken: 'token_test_3',
    })

    expect(outcome.dropped).toBe(1)
    expect(outcome.inserted).toBe(1)
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_test_3')
  })

  it('drops an envelope the contract schema would refuse', () => {
    const nonsense = { not: 'an envelope' } as unknown as ReturnType<ChatItemAdapter>
    const result = normalizeChatItems([{}, {}], () => nonsense, {
      broadcastId: TEST_BROADCAST_ID,
      liveChatId: TEST_LIVE_CHAT_ID,
      receivedAt: '2026-08-17T00:00:00.000Z',
      parseCommand: testParseCommand,
    })

    expect(result.envelopes).toHaveLength(0)
    expect(result.dropped).toBe(2)
  })

  it('reports duplicates rather than failing when a message arrives twice', () => {
    const first = sink()
    first.commit({
      sourceShape: 'grpc',
      items: [grpcFixture('text-message-event')],
      nextPageToken: 'token_test_a',
    })
    const again = first.commit({
      sourceShape: 'grpc',
      items: [grpcFixture('text-message-event')],
      nextPageToken: 'token_test_b',
    })

    expect(again.inserted).toBe(0)
    expect(again.duplicates).toBe(1)
    expect(again.checkpoint.nextPageToken).toBe('token_test_b')
  })

  it('advances the checkpoint for an empty response', () => {
    const outcome = sink().commit({ sourceShape: 'grpc', items: [], nextPageToken: 'token_empty' })

    expect(outcome.accepted).toBe(0)
    expect(outcome.userEventAt).toBeNull()
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_empty')
  })

  it('keeps the last token when a response carries none', () => {
    const resumed = sink('token_restored')
    expect(resumed.pageToken).toBe('token_restored')

    const outcome = resumed.commit({
      sourceShape: 'grpc',
      items: [grpcFixture('text-message-event')],
      nextPageToken: null,
    })

    expect(outcome.checkpoint.nextPageToken).toBe('token_restored')
    expect(resumed.pageToken).toBe('token_restored')
  })

  it('forgets a refused token without erasing what is already stored', () => {
    const resumed = sink()
    resumed.commit({ sourceShape: 'grpc', items: [], nextPageToken: 'token_refused' })
    resumed.forgetPageToken()

    expect(resumed.pageToken).toBeNull()
    // The stored value survives until a fresh token replaces it: it is still the
    // best evidence of where the stream was.
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_refused')
  })
})
