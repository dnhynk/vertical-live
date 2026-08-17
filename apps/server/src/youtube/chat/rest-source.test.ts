import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { systemClock } from '../../clock.js'
import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import {
  FakeLiveChatRestServer,
  type FakeRestStep,
} from '../../testing/fake-live-chat-rest-server.js'
import {
  TEST_BROADCAST_ID,
  TEST_LIVE_CHAT_ID,
  TEST_SOURCE_KEY,
  fixedTokens,
  restFixture,
  storeInbox,
  testChatConfig,
  testParseCommand,
} from '../../testing/chat-test-support.js'
import { FakeClock } from '../../testing/fake-clock.js'
import type { ChatConfig } from './config.js'
import { CancellableDelay, type ChatAccessTokens } from './retry.js'
import { RestChatSource } from './rest-source.js'
import { ChatIngestSink } from './sink.js'
import { ChatSourceState } from './state.js'

/**
 * The REST fallback of TASK_SPECS §T9: same checkpoint, same envelopes, and the
 * server's `pollingIntervalMillis` respected (spec §4).
 */

const TEXT_MESSAGE = restFixture('text-message-event')
const SUPER_CHAT = restFixture('super-chat-event')

interface Harness {
  readonly server: FakeLiveChatRestServer
  readonly source: RestChatSource
  readonly state: ChatSourceState
  readonly sink: ChatIngestSink
}

describe('RestChatSource', () => {
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
    script: readonly FakeRestStep[],
    options: {
      config?: Partial<ChatConfig>
      auth?: ChatAccessTokens
      initialPageToken?: string | null
    } = {},
  ): Promise<Harness> {
    const server = await FakeLiveChatRestServer.start(script)
    const base = testChatConfig(options.config)
    const config: ChatConfig = {
      ...base,
      rest: { ...base.rest, baseUrl: server.baseUrl },
    }
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
    const source = new RestChatSource({
      sink,
      state,
      clock: systemClock,
      config,
      auth: options.auth ?? fixedTokens(),
      liveChatId: TEST_LIVE_CHAT_ID,
      random: () => 0,
    })
    cleanups.push(async () => {
      source.stop()
      await server.stop()
    })
    return { server, source, state, sink }
  }

  it('ingests polled items and shares the checkpoint with the gRPC path', async () => {
    const h = await harness([
      { body: { items: [TEXT_MESSAGE, SUPER_CHAT], nextPageToken: 'rest_token_1' } },
      { status: 403, body: { error: { code: 403, errors: [{ reason: 'liveChatEnded' }] } } },
    ])

    const result = await h.source.run()

    expect(result.outcome).toBe('stopped')
    expect(temp.store.drainUnprocessed(0, 10).map((row) => row.envelope.sourceShape)).toEqual([
      'rest',
      'rest',
    ])
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('rest_token_1')
  })

  it('requests id,snippet only and resumes from the stored token', async () => {
    const h = await harness(
      [
        { body: { items: [], nextPageToken: 'rest_token_2' } },
        { status: 403, body: { error: { code: 403, errors: [{ reason: 'liveChatEnded' }] } } },
      ],
      { initialPageToken: 'rest_token_restored' },
    )

    await h.source.run()

    const first = h.server.requests[0]
    expect(first?.parts).toEqual(['id', 'snippet'])
    expect(first?.parts).not.toContain('authorDetails')
    expect(first?.pageToken).toBe('rest_token_restored')
    expect(first?.authorized).toBe(true)
    expect(h.server.requests[1]?.pageToken).toBe('rest_token_2')
  })

  it('obeys the server-supplied polling interval, clamped to the configured bounds', () => {
    const config = testChatConfig()
    const source = new RestChatSource({
      sink: {} as unknown as ChatIngestSink,
      state: new ChatSourceState(new FakeClock(), config.grpc.keepalive),
      clock: new FakeClock(),
      config: {
        ...config,
        rest: { ...config.rest, minPollIntervalMs: 1000, maxPollIntervalMs: 10_000 },
      },
      auth: fixedTokens(),
      liveChatId: TEST_LIVE_CHAT_ID,
    })

    expect(source.pollDelayMs(5000)).toBe(5000)
    // A server that asks for less than the floor still gets the floor; asking
    // for more than the ceiling cannot stall ingestion for an hour.
    expect(source.pollDelayMs(10)).toBe(1000)
    expect(source.pollDelayMs(3_600_000)).toBe(10_000)
    // No value at all: the configured floor, never zero (which would be the
    // "sent too quickly" error the reference warns about).
    expect(source.pollDelayMs(undefined)).toBe(1000)
    expect(source.pollDelayMs(Number.NaN)).toBe(1000)
  })

  it('waits the interval the server asked for between polls', async () => {
    const h = await harness([
      { body: { items: [], nextPageToken: 'rest_a', pollingIntervalMillis: 40 } },
      { status: 403, body: { error: { code: 403, errors: [{ reason: 'liveChatEnded' }] } } },
    ])

    const startedAt = Date.now()
    await h.source.run()

    expect(h.server.requests).toHaveLength(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35)
  })

  it('retries a rate limit and keeps the checkpoint', async () => {
    const h = await harness([
      { status: 403, body: { error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } } },
      { body: { items: [TEXT_MESSAGE], nextPageToken: 'rest_after_retry' } },
      { status: 403, body: { error: { code: 403, errors: [{ reason: 'liveChatEnded' }] } } },
    ])

    await h.source.run()

    expect(h.server.requests.length).toBeGreaterThanOrEqual(3)
    expect(temp.store.getSourceCheckpoint(TEST_SOURCE_KEY)?.nextPageToken).toBe('rest_after_retry')
  })

  it('stops when the live chat is not found', async () => {
    const h = await harness([
      { status: 404, body: { error: { code: 404, errors: [{ reason: 'liveChatNotFound' }] } } },
    ])

    expect(await h.source.run()).toEqual({ outcome: 'stopped', reason: 'notFound' })
  })

  it('refreshes the token once on 401 and stops if it recurs', async () => {
    const auth = fixedTokens()
    const h = await harness([{ status: 401, body: { error: { code: 401 } } }], { auth })

    const result = await h.source.run()

    expect(auth.refreshes).toBe(1)
    expect(result).toEqual({ outcome: 'stopped', reason: 'unauthenticated' })
  })

  it('hands the primary path back after the configured cool-off', async () => {
    const h = await harness([{ body: { items: [], nextPageToken: 'rest_x' } }], {
      config: { fallback: { enterAfterConsecutiveFailures: 3, retryPrimaryAfterMs: 30 } },
    })

    const result = await h.source.run()

    expect(result).toEqual({ outcome: 'switch_back', reason: 'retry_primary' })
  })

  it('stops when it is asked to', async () => {
    const h = await harness([{ body: { items: [], nextPageToken: 'rest_y' } }])

    const running = h.source.run()
    const delay = new CancellableDelay(systemClock)
    await delay.wait(20)
    h.source.stop()

    expect((await running).outcome).toBe('cancelled')
  })
})
