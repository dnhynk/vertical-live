import { ChannelCredentials, status } from '@grpc/grpc-js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { systemClock } from '../../clock.js'
import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import type { HealthSignal } from '../../health/types.js'
import {
  TEST_LIVE_CHAT_ID,
  TEST_SOURCE_KEY,
  fixedTokens,
  grpcFixture,
  restFixture,
  storeInbox,
  testChatConfig,
  testParseCommand,
} from '../../testing/chat-test-support.js'
import { FakeLiveChatRestServer } from '../../testing/fake-live-chat-rest-server.js'
import {
  FakeStreamListServer,
  type FakeConnectionScript,
} from '../../testing/fake-stream-list-server.js'
import { ChatSource } from './chat-source.js'
import type { ChatConfig } from './config.js'
import { CHAT_TRANSPORT_SIGNAL, CHAT_USER_EVENTS_SIGNAL } from './health.js'
import { CancellableDelay } from './retry.js'
import { GrpcStreamListTransport } from './transport.js'

/**
 * The source as the server runs it: engine gate first (spec §7.3(3)), then the
 * primary path, then the fallback with the same checkpoint (TASK_SPECS §T9).
 */

const GRPC_MESSAGE = grpcFixture('text-message-event')
const REST_MESSAGE = restFixture('super-chat-event')

describe('ChatSource', () => {
  let temp: TempStore
  const cleanups: (() => Promise<void>)[] = []

  beforeEach(() => {
    temp = createTempStore({ clock: systemClock })
  })

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    temp.dispose()
  })

  async function fakes(
    script: readonly FakeConnectionScript[],
    restScript: Parameters<typeof FakeLiveChatRestServer.start>[0] = [{ body: {} }],
  ): Promise<{ grpc: FakeStreamListServer; rest: FakeLiveChatRestServer }> {
    const grpc = await FakeStreamListServer.start({ script })
    const rest = await FakeLiveChatRestServer.start(restScript)
    cleanups.push(async () => {
      await grpc.stop()
      await rest.stop()
    })
    return { grpc, rest }
  }

  function source(
    servers: { grpc: FakeStreamListServer; rest: FakeLiveChatRestServer },
    overrides: Partial<ChatConfig> = {},
    engine: { ready: boolean } = { ready: true },
    signals: HealthSignal[] = [],
    resolveTarget?: () => { liveChatId: string; broadcastId: string } | null,
  ): ChatSource {
    const base = testChatConfig(overrides)
    const config: ChatConfig = {
      ...base,
      grpc: { ...base.grpc, endpoint: servers.grpc.endpoint },
      rest: { ...base.rest, baseUrl: servers.rest.baseUrl },
    }
    const transport = new GrpcStreamListTransport({
      endpoint: config.grpc.endpoint,
      keepalive: config.grpc.keepalive,
      credentials: ChannelCredentials.createInsecure(),
    })
    const chat = new ChatSource({
      config,
      clock: systemClock,
      inbox: storeInbox(temp.store),
      checkpoints: temp.store,
      parseCommand: testParseCommand,
      auth: fixedTokens(),
      engine,
      transport,
      healthSink: (signal) => signals.push(signal),
      ...(resolveTarget === undefined ? {} : { resolveTarget }),
      random: () => 0,
    })
    cleanups.push(async () => {
      await chat.stop()
      transport.close()
    })
    return chat
  }

  it('waits for the engine to finish its recovery drain before connecting', async () => {
    const servers = await fakes([
      { responses: [{ items: [GRPC_MESSAGE], next_page_token: 'token_1' }] },
      { end: { errorCode: status.PERMISSION_DENIED } },
      { end: { errorCode: status.PERMISSION_DENIED } },
    ])
    const engine = { ready: false }
    const chat = source(servers, {}, engine)

    chat.start()
    await new CancellableDelay(systemClock).wait(60)
    // Nothing may be received while the engine is still draining its inbox.
    expect(servers.grpc.connectionCount).toBe(0)

    engine.ready = true
    await waitFor(() => servers.grpc.connectionCount > 0)
    await waitFor(() => chat.lastResult !== null)
    expect(temp.store.drainUnprocessed(0, 10)).toHaveLength(1)
  })

  it('falls back to REST and keeps the same checkpoint', async () => {
    const servers = await fakes(
      [
        { responses: [{ items: [GRPC_MESSAGE], next_page_token: 'token_grpc' }], end: 'complete' },
        { end: { errorCode: status.UNAVAILABLE } },
      ],
      [
        { body: { items: [REST_MESSAGE], nextPageToken: 'token_rest' } },
        { status: 403, body: { error: { code: 403, errors: [{ reason: 'liveChatEnded' }] } } },
      ],
    )
    const chat = source(servers, {
      fallback: { enterAfterConsecutiveFailures: 2, retryPrimaryAfterMs: 60_000 },
    })

    chat.start()
    await waitFor(() => chat.lastResult?.outcome === 'stopped')

    // The poller resumed from the token the gRPC path stored.
    expect(servers.rest.requests[0]?.pageToken).toBe('token_grpc')
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_rest')
    const shapes = temp.store.drainUnprocessed(0, 10).map((row) => row.envelope.sourceShape)
    expect(shapes).toEqual(['grpc', 'rest'])
  })

  it('neither connects nor fails when no liveChatId is available', async () => {
    const servers = await fakes([{ end: 'complete' }])
    const signals: HealthSignal[] = []
    const chat = source(servers, { liveChatId: null, broadcastId: null }, { ready: true }, signals)

    chat.start()
    await waitFor(() => signals.length > 0)

    expect(servers.grpc.connectionCount).toBe(0)
    const transport = signals.find((signal) => signal.name === CHAT_TRANSPORT_SIGNAL)
    expect(transport?.status).toBe('degraded')
    expect(transport?.reason).toBe('no_live_chat_id')
  })

  it('stays inert while the config switch is off', async () => {
    const servers = await fakes([{ end: 'complete' }])
    const chat = source(servers, { enabled: false })

    chat.start()
    await new CancellableDelay(systemClock).wait(40)

    expect(servers.grpc.connectionCount).toBe(0)
    expect(chat.observe().mode).toBe('idle')
    expect(chat.transportReady()).toBe(false)
  })

  it('publishes the four health signals, with silence reported as ok', async () => {
    const servers = await fakes([
      { responses: [{ items: [], next_page_token: 'token_quiet' }] },
      { end: { errorCode: status.PERMISSION_DENIED } },
      { end: { errorCode: status.PERMISSION_DENIED } },
    ])
    const chat = source(servers)

    chat.start()
    await waitFor(() => chat.lastResult !== null)

    const signals = chat.signals()
    expect(signals).toHaveLength(4)
    const userEvents = signals.find((signal) => signal.name === CHAT_USER_EVENTS_SIGNAL)
    expect(userEvents?.status).toBe('ok')
    expect(userEvents?.detail['totalUserEvents']).toBe(0)
    // The empty response still moved the resume point.
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('token_quiet')
    expect(chat.observe().pageToken).toBe('token_quiet')
    expect(chat.observe().mode).toBe('grpc')
    expect(TEST_LIVE_CHAT_ID).toBe('chat_test_0001')
  })

  // T28, against a real channel: the server accepts the call and sends nothing,
  // which is what a live chat nobody is typing in does. The transport is up, so
  // the supervisor must be able to reach `live` — before the fix this state was
  // `unknown`, and the restart it earned closed the very connection it was
  // waiting on.
  it('reports the transport as ok on a call the server has answered with nothing', async () => {
    const servers = await fakes([{ end: 'hang' }])
    const chat = source(servers)

    chat.start()
    await waitFor(() => servers.grpc.connectionCount > 0)
    await waitFor(() => chat.observe().channelState === 'READY')

    const transport = chat.signals().find((signal) => signal.name === CHAT_TRANSPORT_SIGNAL)
    expect(transport?.status).toBe('ok')
    expect(chat.transportReady()).toBe(true)
    // Nothing has been delivered: this is readiness of the path, not of a message.
    expect(chat.observe().connected).toBe(false)
    expect(transport?.detail['lastResponseAt']).toBeNull()
  })

  /**
   * T36. A segment rollover replaces the broadcast and with it the `liveChatId`
   * (BOARD D-21), and the listener has to follow. Measured on 2026-08-23: it did
   * not — the source stayed on a broadcast two swaps old, reconnected to it 28
   * times, and `transport` reported `ok` the whole time because the channel to
   * that dead chat was `READY`.
   */
  describe('ChatSource follows the bound chat', () => {
    it('moves to the new liveChatId when the binding changes', async () => {
      const servers = await fakes([
        // First chat: one response, then the stream ends and the loop looks again.
        { responses: [{ items: [], next_page_token: 'token_first' }] },
        { end: 'complete' },
        { end: 'complete' },
      ])
      let target = { liveChatId: 'chat_test_0001', broadcastId: 'broadcast_first' }
      const chat = source(servers, {}, { ready: true }, [], () => target)

      chat.start()
      await waitFor(() => chat.observe().liveChatId === 'chat_test_0001')

      // The rollover: a new broadcast, a new chat.
      target = { liveChatId: 'chat_test_0002', broadcastId: 'broadcast_second' }

      await waitFor(() => chat.observe().liveChatId === 'chat_test_0002')
      // Nothing restarted it — it followed the binding on its own, which is what
      // keeps the supervisor the only owner of component restarts (spec §9.2).
      expect(chat.observe().liveChatId).toBe('chat_test_0002')
    })

    it('reports which chat it is reading', async () => {
      const servers = await fakes([{ end: 'hang' }])
      const chat = source(servers)

      chat.start()
      await waitFor(() => chat.observe().liveChatId !== null)

      const transport = chat.signals().find((signal) => signal.name === CHAT_TRANSPORT_SIGNAL)
      // Without this on `/health`, a swap can leave the input path on the wrong
      // broadcast while the signal still says `ok`.
      expect(transport?.detail['liveChatId']).toBe(TEST_LIVE_CHAT_ID)
    })
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const delay = new CancellableDelay(systemClock)
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await delay.wait(5)
  }
}
