import { ChannelCredentials, status } from '@grpc/grpc-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { systemClock } from '../../clock.js'
import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import {
  FakeStreamListServer,
  type FakeConnectionScript,
} from '../../testing/fake-stream-list-server.js'
import { TcpBreaker } from '../../testing/tcp-breaker.js'
import {
  TEST_BROADCAST_ID,
  TEST_LIVE_CHAT_ID,
  TEST_SOURCE_KEY,
  fixedTokens,
  grpcFixture,
  storeInbox,
  testChatConfig,
  testParseCommand,
} from '../../testing/chat-test-support.js'
import { AuthRevokedError } from '../auth/token-manager.js'
import type { ChatConfig } from './config.js'
import { GrpcChatSource } from './grpc-source.js'
import { CancellableDelay, type ChatAccessTokens } from './retry.js'
import { ChatIngestSink } from './sink.js'
import { ChatSourceState } from './state.js'
import { GrpcStreamListTransport } from './transport.js'

/**
 * TASK_SPECS §T9 acceptance 1 and 2, against a real gRPC server that speaks the
 * copied proto: receive, resume from the token, survive a mid-stream break,
 * survive a poison item, switch to the fallback — and never ask for
 * `authorDetails`.
 *
 * These use the system clock with millisecond-scale backoff rather than a
 * virtual one: the transport is real, so the test has to wait for real I/O
 * anyway, and a virtual clock would only hide the interleaving.
 */

const TEXT_MESSAGE = grpcFixture('text-message-event')
const SUPER_CHAT = grpcFixture('super-chat-event')
/** `snippet.published_at` missing: the adapter must still yield an envelope. */
const POISON = grpcFixture('invalid-missing-published-at')

interface Harness {
  readonly server: FakeStreamListServer
  readonly source: GrpcChatSource
  readonly state: ChatSourceState
  readonly sink: ChatIngestSink
  readonly temp: TempStore
  readonly breaker: TcpBreaker | undefined
  stop(): Promise<void>
}

describe('GrpcChatSource', () => {
  let temp: TempStore
  const cleanups: (() => Promise<void>)[] = []

  beforeEach(() => {
    temp = createTempStore({ clock: systemClock })
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    temp.dispose()
  })

  async function harness(
    script: readonly FakeConnectionScript[],
    options: {
      config?: Partial<ChatConfig>
      auth?: ChatAccessTokens
      initialPageToken?: string | null
      /** Dial through a relay whose sockets the test can sever. */
      throughBreaker?: boolean
    } = {},
  ): Promise<Harness> {
    const server = await FakeStreamListServer.start({ script })
    const breaker =
      options.throughBreaker === true ? await TcpBreaker.start(server.endpoint) : undefined
    const config = testChatConfig({
      grpc: {
        endpoint: breaker?.endpoint ?? server.endpoint,
        keepalive: { timeMs: 300_000, timeoutMs: 20_000, permitWithoutCalls: false },
      },
      ...options.config,
    })
    const transport = new GrpcStreamListTransport({
      endpoint: config.grpc.endpoint,
      keepalive: config.grpc.keepalive,
      credentials: ChannelCredentials.createInsecure(),
    })
    const sink = new ChatIngestSink({
      inbox: storeInbox(temp.store),
      clock: systemClock,
      parseCommand: testParseCommand,
      sourceKey: TEST_SOURCE_KEY,
      liveChatId: TEST_LIVE_CHAT_ID,
      broadcastId: TEST_BROADCAST_ID,
      initialPageToken: options.initialPageToken ?? null,
    })
    const state = new ChatSourceState(systemClock, config.grpc.keepalive)
    const source = new GrpcChatSource({
      transport,
      sink,
      state,
      clock: systemClock,
      config,
      auth: options.auth ?? fixedTokens(),
      liveChatId: TEST_LIVE_CHAT_ID,
      random: () => 0,
    })
    const stop = async (): Promise<void> => {
      source.stop()
      transport.close()
      await server.stop()
      await breaker?.stop()
    }
    cleanups.push(stop)
    return { server, source, state, sink, temp, breaker, stop }
  }

  it('ingests the items of a streamed response and stores the resume token', async () => {
    const h = await harness([
      { responses: [{ items: [TEXT_MESSAGE, SUPER_CHAT], next_page_token: 'token_1' }] },
      { end: { errorCode: status.PERMISSION_DENIED } },
      { end: { errorCode: status.PERMISSION_DENIED } },
    ])

    await h.source.run()

    const rows = temp.store.drainUnprocessed(0, 10)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.envelope.sourceShape)).toEqual(['grpc', 'grpc'])
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_1')
  })

  it('requests id,snippet only while the consent gate is closed', async () => {
    const h = await harness([
      { responses: [{ items: [TEXT_MESSAGE], next_page_token: 'token_1' }] },
      { end: { errorCode: status.PERMISSION_DENIED } },
      { end: { errorCode: status.PERMISSION_DENIED } },
    ])

    await h.source.run()

    expect(h.server.requests.length).toBeGreaterThan(0)
    for (const request of h.server.requests) {
      expect(request.parts).toEqual(['id', 'snippet'])
      expect(request.parts).not.toContain('authorDetails')
      expect(request.authorized).toBe(true)
      expect(request.liveChatId).toBe(TEST_LIVE_CHAT_ID)
    }
  })

  it('adds authorDetails to the request when the consent gate is open', async () => {
    // BOARD D-9: the part is what makes a `JOIN` recognizable. `loadChatConfig`
    // derives the list from the gate, and this asserts the derived list actually
    // reaches the wire (spec §7.2).
    const h = await harness(
      [
        { responses: [{ items: [TEXT_MESSAGE], next_page_token: 'token_1' }] },
        { end: { errorCode: status.PERMISSION_DENIED } },
        { end: { errorCode: status.PERMISSION_DENIED } },
      ],
      { config: { identityGateOpen: true, parts: ['id', 'snippet', 'authorDetails'] } },
    )

    await h.source.run()

    expect(h.server.requests.length).toBeGreaterThan(0)
    for (const request of h.server.requests) {
      expect(request.parts).toEqual(['id', 'snippet', 'authorDetails'])
    }
  })

  it('resumes from the stored token after the connection is cut mid-stream', async () => {
    const h = await harness(
      [
        // The first connection delivers a message and then stays open, so the
        // break below is a real severed socket rather than a clean end.
        { responses: [{ items: [TEXT_MESSAGE], next_page_token: 'token_1' }], end: 'hang' },
        { responses: [{ items: [SUPER_CHAT], next_page_token: 'token_2' }] },
        { end: { errorCode: status.PERMISSION_DENIED } },
        { end: { errorCode: status.PERMISSION_DENIED } },
      ],
      { throughBreaker: true },
    )

    const running = h.source.run()
    await waitFor(
      () => temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken === 'token_1',
    )
    h.breaker?.breakAll()
    await running

    const second = h.server.requests[1]
    expect(second?.pageToken).toBe('token_1')
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_2')
    const observation = h.state.observe(h.sink.pageToken, null)
    expect(observation.reconnect.count).toBeGreaterThanOrEqual(1)
    expect(observation.reconnect.resumedWithToken).toBe(true)
    expect(observation.reconnect.estimatedLostMessages).toBe(0)
  })

  it('resumes from a checkpoint restored at start-up', async () => {
    const h = await harness(
      [
        { responses: [{ items: [TEXT_MESSAGE], next_page_token: 'token_9' }] },
        { end: { errorCode: status.PERMISSION_DENIED } },
        { end: { errorCode: status.PERMISSION_DENIED } },
      ],
      { initialPageToken: 'token_restored' },
    )

    await h.source.run()

    expect(h.server.requests[0]?.pageToken).toBe('token_restored')
  })

  it('commits a poison item as a minimal envelope and keeps going', async () => {
    const h = await harness([
      { responses: [{ items: [POISON, TEXT_MESSAGE], next_page_token: 'token_p' }] },
      { end: { errorCode: status.PERMISSION_DENIED } },
      { end: { errorCode: status.PERMISSION_DENIED } },
    ])

    await h.source.run()

    const statuses = temp.store.drainUnprocessed(0, 10).map((row) => row.envelope.validationStatus)
    expect(statuses).toEqual(['invalid', 'valid'])
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_p')
    expect(h.state.droppedItems).toBe(0)
  })

  it('counts a duplicate after a reconnect instead of failing on it', async () => {
    const h = await harness([
      { responses: [{ items: [TEXT_MESSAGE], next_page_token: 'token_1' }], end: 'complete' },
      { responses: [{ items: [TEXT_MESSAGE], next_page_token: 'token_1' }], end: 'complete' },
      { end: { errorCode: status.PERMISSION_DENIED } },
      { end: { errorCode: status.PERMISSION_DENIED } },
    ])

    await h.source.run()

    expect(temp.store.drainUnprocessed(0, 10)).toHaveLength(1)
    expect(h.state.observe(null, null).reconnect.estimatedDuplicates).toBeGreaterThanOrEqual(1)
  })

  it('hands over to the fallback after the configured consecutive failures', async () => {
    const h = await harness([{ end: { errorCode: status.UNAVAILABLE } }], {
      config: { fallback: { enterAfterConsecutiveFailures: 2, retryPrimaryAfterMs: 60_000 } },
    })

    const result = await h.source.run()

    expect(result.outcome).toBe('fallback')
    expect(h.server.connectionCount).toBe(2)
  })

  it('refreshes the token once on UNAUTHENTICATED and stops if it recurs', async () => {
    const auth = fixedTokens()
    const h = await harness([{ end: { errorCode: status.UNAUTHENTICATED } }], { auth })

    const result = await h.source.run()

    expect(auth.refreshes).toBe(1)
    expect(result).toEqual({ outcome: 'stopped', reason: 'unauthenticated' })
    expect(h.state.observe(null, null).stopped?.reason).toBe('unauthenticated')
  })

  it('stops with auth_revoked when the refresh says the grant is gone', async () => {
    const auth: ChatAccessTokens = {
      getAccessToken: () => Promise.resolve('test-access-token'),
      forceRefresh: () => Promise.reject(new AuthRevokedError('invalid_grant')),
    }
    const h = await harness([{ end: { errorCode: status.PERMISSION_DENIED } }], { auth })

    const result = await h.source.run()

    expect(result).toEqual({ outcome: 'stopped', reason: 'auth_revoked' })
  })

  it('stops when the chat has ended (FAILED_PRECONDITION)', async () => {
    const h = await harness([
      { end: { errorCode: status.FAILED_PRECONDITION, details: 'LIVE_CHAT_ENDED' } },
    ])

    const result = await h.source.run()

    expect(result.outcome).toBe('stopped')
    expect(result.reason).toBe('failedPrecondition')
  })

  it('drops a resume token the server refuses and says the resume point is gone', async () => {
    const h = await harness(
      [
        { end: { errorCode: status.INVALID_ARGUMENT } },
        { responses: [{ items: [TEXT_MESSAGE], next_page_token: 'token_fresh' }] },
        { end: { errorCode: status.PERMISSION_DENIED } },
        { end: { errorCode: status.PERMISSION_DENIED } },
      ],
      { initialPageToken: 'token_stale' },
    )

    await h.source.run()

    expect(h.server.requests[0]?.pageToken).toBe('token_stale')
    expect(h.server.requests[1]?.pageToken).toBeUndefined()
    const observation = h.state.observe(h.sink.pageToken, null)
    // The stored resume point is gone: whatever was posted between it and the
    // fresh stream cannot be recovered, and `tokenRejected` is the sticky fact
    // that says so (the reconnect signal reads `degraded / resumed_without_token`
    // off it).
    expect(observation.reconnect.tokenRejected).toBe(true)
    // No reconnect is counted, and that is the point of the round-1 fix: this
    // run never received anything before the refusal, so there was no live path
    // to recover. Counting it would be an inferred number, not a measured one.
    expect(observation.reconnect.count).toBe(0)
  })

  it('stops when it is asked to', async () => {
    const h = await harness([{ end: 'hang' }])

    const running = h.source.run()
    await waitFor(() => h.server.connectionCount === 1)
    h.source.stop()

    expect((await running).outcome).toBe('cancelled')
  })
})

/** Polls a predicate on the real clock; these tests await real I/O. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const delay = new CancellableDelay(systemClock)
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await delay.wait(5)
  }
}
