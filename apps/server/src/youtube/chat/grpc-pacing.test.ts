import type { ServiceError } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'

import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import { FakeClock, flushMicrotasks } from '../../testing/fake-clock.js'
import {
  TEST_BROADCAST_ID,
  TEST_LIVE_CHAT_ID,
  TEST_SOURCE_KEY,
  fixedTokens,
  storeInbox,
  testChatConfig,
  testParseCommand,
} from '../../testing/chat-test-support.js'
import { QuotaTracker } from '../quota/tracker.js'
import { GrpcChatSource } from './grpc-source.js'
import { ChatIngestSink } from './sink.js'
import { ChatSourceState } from './state.js'
import type {
  StreamListCall,
  StreamListRequest,
  StreamListResponse,
  StreamListTransport,
} from './transport.js'

interface Script {
  readonly response?: StreamListResponse
  /** Omit for an immediate normal end. */
  readonly endAfterMs?: number
}

class VirtualCall implements StreamListCall {
  #data: ((response: StreamListResponse) => void) | undefined
  #error: ((error: ServiceError) => void) | undefined
  #end: (() => void) | undefined
  #cancelled = false

  constructor(
    private readonly clock: FakeClock,
    private readonly script: Script,
  ) {}

  onData(handler: (response: StreamListResponse) => void): void {
    this.#data = handler
  }

  onError(handler: (error: ServiceError) => void): void {
    this.#error = handler
  }

  onEnd(handler: () => void): void {
    this.#end = handler
    queueMicrotask(() => {
      if (this.#cancelled) return
      if (this.script.response !== undefined) this.#data?.(this.script.response)
      const endAfterMs = this.script.endAfterMs ?? 0
      if (endAfterMs === 0) this.#end?.()
      else this.clock.setTimeout(() => this.#end?.(), endAfterMs)
    })
  }

  cancel(): void {
    this.#cancelled = true
    // These tests stop during a pacing wait, after the call has ended. Retain
    // the handler to satisfy the real transport's subscription shape.
    void this.#error
  }
}

class VirtualTransport implements StreamListTransport {
  readonly starts: number[] = []
  readonly requests: StreamListRequest[] = []
  #next = 0

  constructor(
    private readonly clock: FakeClock,
    private readonly scripts: readonly Script[],
  ) {}

  open(request: StreamListRequest): StreamListCall {
    const script = this.scripts[this.#next]
    if (script === undefined) throw new Error('unexpected stream open')
    this.#next += 1
    this.starts.push(this.clock.monotonicMs())
    this.requests.push(request)
    return new VirtualCall(this.clock, script)
  }

  channelState(): string {
    return 'READY'
  }

  close(): void {}
}

describe('GrpcChatSource successful-close pacing', () => {
  let temp: TempStore | undefined

  afterEach(() => {
    temp?.dispose()
    temp = undefined
  })

  function createSource(
    scripts: readonly Script[],
    intervalMs = 25_000,
  ): {
    source: GrpcChatSource
    transport: VirtualTransport
    state: ChatSourceState
    quota: QuotaTracker
    clock: FakeClock
  } {
    const clock = new FakeClock()
    temp = createTempStore({ clock })
    const config = testChatConfig({
      successfulStreamMinStartIntervalMs: intervalMs,
      reconnect: {
        initialDelayMs: 1_000,
        maxDelayMs: 1_000,
        factor: 1,
        jitterRatio: 0,
        maxAttempts: 8,
      },
    })
    const transport = new VirtualTransport(clock, scripts)
    const sink = new ChatIngestSink({
      inbox: storeInbox(temp.store),
      clock,
      parseCommand: testParseCommand,
      sourceKey: TEST_SOURCE_KEY,
      liveChatId: TEST_LIVE_CHAT_ID,
      broadcastId: TEST_BROADCAST_ID,
    })
    const state = new ChatSourceState(clock, config.grpc.keepalive)
    const quota = new QuotaTracker({ clock })
    const source = new GrpcChatSource({
      transport,
      sink,
      state,
      clock,
      config,
      auth: fixedTokens(),
      liveChatId: TEST_LIVE_CHAT_ID,
      quota,
      random: () => 0,
    })
    return { source, transport, state, quota, clock }
  }

  it('caps rapid normal closes, resumes each durable token, and records actual requests once', async () => {
    const h = createSource([
      { response: { items: [], next_page_token: 'token_1' } },
      { response: { items: [], next_page_token: 'token_2' } },
      { response: { items: [], next_page_token: 'token_3' } },
      { response: { items: [], next_page_token: 'token_4' } },
    ])

    const running = h.source.run()
    await flushMicrotasks()
    expect(h.transport.starts).toEqual([0])

    await h.clock.advance(24_999)
    expect(h.transport.starts).toEqual([0])
    await h.clock.advance(1)
    await h.clock.advance(25_000)
    await h.clock.advance(25_000)

    expect(h.transport.starts).toEqual([0, 25_000, 50_000, 75_000])
    expect(h.transport.requests.map((request) => request.page_token)).toEqual([
      undefined,
      'token_1',
      'token_2',
      'token_3',
    ])
    expect(h.quota.snapshot()).toMatchObject({
      spentUnits: 4,
      byMethod: { 'liveChatMessages.streamList': 4 },
    })

    h.source.stop()
    await expect(running).resolves.toEqual({ outcome: 'cancelled', reason: 'stop_requested' })
  })

  it('counts stream open time toward the start-to-start interval', async () => {
    const h = createSource([
      { response: { items: [], next_page_token: 'token_open' }, endAfterMs: 10_000 },
      { response: { items: [], next_page_token: 'token_next' } },
    ])

    const running = h.source.run()
    await flushMicrotasks()
    await h.clock.advance(10_000)
    expect(h.state.observe('token_open', 'READY').reconnect.wait).toMatchObject({
      reason: 'successful_close_pacing',
      delayMs: 15_000,
    })
    await h.clock.advance(14_999)
    expect(h.transport.starts).toEqual([0])
    await h.clock.advance(1)
    expect(h.transport.starts).toEqual([0, 25_000])

    h.source.stop()
    await running
  })

  it('cancels a successful-close pace wait without advancing the full interval', async () => {
    const h = createSource([{ response: { items: [], next_page_token: 'token_stop' } }])

    const running = h.source.run()
    await flushMicrotasks()
    expect(h.clock.pendingTimerCount).toBe(1)
    expect(h.state.observe('token_stop', 'READY').reconnect.wait?.reason).toBe(
      'successful_close_pacing',
    )

    h.source.stop()

    await expect(running).resolves.toEqual({ outcome: 'cancelled', reason: 'stop_requested' })
    expect(h.clock.monotonicMs()).toBe(0)
    expect(h.clock.pendingTimerCount).toBe(0)
    expect(h.state.observe('token_stop', 'READY').reconnect.wait).toBeNull()
  })

  it('keeps an empty normal end on error backoff instead of successful pacing', async () => {
    const h = createSource([{}, { response: { items: [], next_page_token: 'token_after_empty' } }])

    const running = h.source.run()
    await flushMicrotasks()
    expect(h.state.observe(null, 'READY').reconnect.wait).toMatchObject({
      reason: 'empty_end_backoff',
      delayMs: 1_000,
    })
    await h.clock.advance(999)
    expect(h.transport.starts).toEqual([0])
    await h.clock.advance(1)
    expect(h.transport.starts).toEqual([0, 1_000])

    h.source.stop()
    await running
  })
})
