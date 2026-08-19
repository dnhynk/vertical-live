import type { CommandParser } from '@vl/contract'
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
import {
  ChatIngestSink,
  ConsentObserveError,
  normalizeChatItems,
  type ChatItemAdapter,
  type ConsentFailure,
} from './sink.js'

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

    expect(result.entries).toHaveLength(0)
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

  it('counts a consent observation and never lets a non-withdrawal one abort the batch', () => {
    // BOARD D-9: the consent directory is shown each raw item as its row is
    // inserted. A failure on an ordinary message must not roll back the response
    // and its checkpoint — that would refetch the same items forever (§7.3(2)) —
    // so it is counted and the stream keeps moving. A failed `LEAVE` is the one
    // exception; see the fail-closed test below (review round 1, B3).
    const seen: unknown[] = []
    const observing = new ChatIngestSink({
      inbox: storeInbox(temp.store),
      clock: temp.clock,
      parseCommand: testParseCommand,
      sourceKey: TEST_SOURCE_KEY,
      liveChatId: TEST_LIVE_CHAT_ID,
      broadcastId: TEST_BROADCAST_ID,
      consent: {
        observe: (rawItem) => {
          seen.push(rawItem)
          if (seen.length === 1) throw new Error('consent store unavailable')
          return { kind: 'joined' }
        },
        duringCommit: (write) => write(),
      },
    })

    const outcome = observing.commit({
      sourceShape: 'grpc',
      items: [grpcFixture('text-message-event'), grpcFixture('super-chat-event')],
      nextPageToken: 'token_consent',
    })

    expect(seen).toHaveLength(2)
    expect(outcome.consentFailed).toBe(1)
    expect(outcome.consentJoined).toBe(1)
    expect(outcome.inserted).toBe(2)
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_consent')
  })

  it('shows the directory only the items it actually inserted', () => {
    // Review round 1 (B1): a duplicate page or a reconnect replays the same
    // `messageId`s. Before the fix the consent side effect ran before the inbox
    // dedupe, so a replayed `JOIN` re-created an identity that a `LEAVE` had
    // already deleted. The decision now follows the dedupe.
    const seen: unknown[] = []
    const observing = new ChatIngestSink({
      inbox: storeInbox(temp.store),
      clock: temp.clock,
      parseCommand: testParseCommand,
      sourceKey: TEST_SOURCE_KEY,
      liveChatId: TEST_LIVE_CHAT_ID,
      broadcastId: TEST_BROADCAST_ID,
      consent: {
        observe: (rawItem) => {
          seen.push(rawItem)
          return { kind: 'joined' }
        },
        duringCommit: (write) => write(),
      },
    })

    const item = grpcFixture('text-message-event')
    const first = observing.commit({ sourceShape: 'grpc', items: [item], nextPageToken: 'token_a' })
    const replay = observing.commit({
      sourceShape: 'grpc',
      items: [item],
      nextPageToken: 'token_b',
    })

    expect(first.inserted).toBe(1)
    expect(replay.inserted).toBe(0)
    expect(replay.duplicates).toBe(1)
    // One insert, one observation — not one per delivery.
    expect(seen).toHaveLength(1)
    expect(replay.consentJoined).toBe(0)
    // The checkpoint still moves: the replay was a real response (§7.3(2)).
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_b')
  })

  it('refuses to commit a batch whose withdrawal could not be applied', () => {
    // Review round 1 (B3): withdrawal is fail-closed. Committing the rows and
    // the checkpoint after a failed `LEAVE` retired the command for good — the
    // retry would see duplicates and skip the decision — so the whole batch
    // rolls back and the same token fetches the same items again.
    const failures: ConsentFailure[] = []
    let failNext = true
    const leaveParser: CommandParser = () => ({ name: 'LEAVE', argument: null })
    const withdrawing = new ChatIngestSink({
      inbox: storeInbox(temp.store),
      clock: temp.clock,
      parseCommand: leaveParser,
      sourceKey: TEST_SOURCE_KEY,
      liveChatId: TEST_LIVE_CHAT_ID,
      broadcastId: TEST_BROADCAST_ID,
      initialPageToken: 'token_before',
      consent: {
        observe: () => {
          if (failNext) throw new Error('consent store unavailable')
          return { kind: 'left' }
        },
        duringCommit: (write) => write(),
      },
      onConsentFailure: (failure) => failures.push(failure),
    })

    const items = [grpcFixture('text-message-event')]
    expect(() =>
      withdrawing.commit({ sourceShape: 'grpc', items, nextPageToken: 'token_after_leave' }),
    ).toThrow(ConsentObserveError)
    expect(failures).toEqual([{ kind: 'withdrawal' }])
    // Nothing landed: no row, and the resume token is still the old one.
    expect(temp.store.drainUnprocessed(0, 10)).toHaveLength(0)
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)).toBeNull()
    expect(withdrawing.pageToken).toBe('token_before')

    // The retry — same items, same token — applies the decision and commits.
    failNext = false
    const retried = withdrawing.commit({
      sourceShape: 'grpc',
      items,
      nextPageToken: 'token_after_leave',
    })
    expect(retried.consentLeft).toBe(1)
    expect(retried.inserted).toBe(1)
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_after_leave')
  })

  it('makes no consent observation at all without a directory', () => {
    const outcome = sink().commit({
      sourceShape: 'grpc',
      items: [grpcFixture('text-message-event')],
      nextPageToken: 'token_1',
    })
    expect(outcome).toMatchObject({ consentJoined: 0, consentLeft: 0, consentFailed: 0 })
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
