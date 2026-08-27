import { status, type ServiceError } from '@grpc/grpc-js'
import { afterEach, describe, expect, it } from 'vitest'

import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import { FakeClock, flushMicrotasks } from '../../testing/fake-clock.js'
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
import { QuotaTracker } from '../quota/tracker.js'
import { ChatSource } from './chat-source.js'
import { GrpcChatSource } from './grpc-source.js'
import { CHAT_TRANSPORT_SIGNAL } from './health.js'
import { ChatIngestSink } from './sink.js'
import { ChatSourceState } from './state.js'
import type {
  StreamListCall,
  StreamListRequest,
  StreamListResponse,
  StreamListTransport,
} from './transport.js'

const GRPC_MESSAGE = grpcFixture('text-message-event')

interface Script {
  readonly response?: StreamListResponse
  /** Omit for an immediate normal end. */
  readonly endAfterMs?: number
  /** When present, terminate with this gRPC error after any response. */
  readonly errorCode?: status
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
      const terminate = (): void => {
        if (this.script.errorCode === undefined) this.#end?.()
        else {
          this.#error?.({
            code: this.script.errorCode,
            details: 'synthetic pacing test error',
          } as ServiceError)
        }
      }
      if (endAfterMs === 0) terminate()
      else this.clock.setTimeout(terminate, endAfterMs)
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

describe('GrpcChatSource quota start pacing', () => {
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
      grpcStreamMinStartIntervalMs: intervalMs,
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
      reason: 'quota_start_pacing',
      delayMs: 15_000,
    })
    await h.clock.advance(14_999)
    expect(h.transport.starts).toEqual([0])
    await h.clock.advance(1)
    expect(h.transport.starts).toEqual([0, 25_000])

    h.source.stop()
    await running
  })

  it('cancels a quota start pace wait without advancing the full interval', async () => {
    const h = createSource([{ response: { items: [], next_page_token: 'token_stop' } }])

    const running = h.source.run()
    await flushMicrotasks()
    expect(h.clock.pendingTimerCount).toBe(1)
    expect(h.state.observe('token_stop', 'READY').reconnect.wait?.reason).toBe('quota_start_pacing')

    h.source.stop()

    await expect(running).resolves.toEqual({ outcome: 'cancelled', reason: 'stop_requested' })
    expect(h.clock.monotonicMs()).toBe(0)
    expect(h.clock.pendingTimerCount).toBe(0)
    expect(h.state.observe('token_stop', 'READY').reconnect.wait).toBeNull()
  })

  it('cancels the old wait on retarget but keeps the prior start floor for the new chat', async () => {
    const clock = new FakeClock()
    temp = createTempStore({ clock })
    const transport = new VirtualTransport(clock, [
      { response: { items: [], next_page_token: 'token_first_chat' } },
      { response: { items: [], next_page_token: 'token_second_chat' } },
    ])
    const config = testChatConfig({
      grpcStreamMinStartIntervalMs: 25_000,
      readyPollIntervalMs: 1_000,
    })
    let target = {
      liveChatId: TEST_LIVE_CHAT_ID,
      broadcastId: TEST_BROADCAST_ID,
    }
    const chat = new ChatSource({
      config,
      clock,
      inbox: storeInbox(temp.store),
      checkpoints: temp.store,
      parseCommand: testParseCommand,
      auth: fixedTokens(),
      engine: { ready: true },
      resolveTarget: () => target,
      transport,
      random: () => 0,
    })

    chat.start()
    chat.start()
    await flushMicrotasks()
    expect(transport.starts).toEqual([0])

    target = {
      liveChatId: 'chat_test_retargeted',
      broadcastId: 'brd_test_retargeted',
    }
    await clock.advance(1_000)
    expect(chat.observe().liveChatId).toBe('chat_test_retargeted')
    expect(chat.observe().reconnect.wait).toMatchObject({
      reason: 'quota_start_pacing',
      delayMs: 24_000,
    })

    await clock.advance(23_999)
    expect(transport.starts).toEqual([0])
    await clock.advance(1)
    expect(transport.starts).toEqual([0, 25_000])
    expect(transport.requests.map((request) => request.live_chat_id)).toEqual([
      TEST_LIVE_CHAT_ID,
      'chat_test_retargeted',
    ])

    await chat.stop()
  })

  it('restarts the same production ChatSource after stop without bypassing the shared start floor', async () => {
    const clock = new FakeClock()
    temp = createTempStore({ clock })
    const transport = new VirtualTransport(clock, [
      { errorCode: status.UNAUTHENTICATED },
      { response: { items: [], next_page_token: 'token_after_restart' } },
    ])
    const config = testChatConfig({
      grpcStreamMinStartIntervalMs: 25_000,
      readyPollIntervalMs: 1_000,
    })
    const quota = new QuotaTracker({ clock })
    let revokeFirstRefresh = true
    const chat = new ChatSource({
      config,
      clock,
      inbox: storeInbox(temp.store),
      checkpoints: temp.store,
      parseCommand: testParseCommand,
      auth: {
        getAccessToken: () => Promise.resolve('synthetic_access_token'),
        forceRefresh: () => {
          if (revokeFirstRefresh) {
            revokeFirstRefresh = false
            return Promise.reject(new AuthRevokedError('invalid_grant'))
          }
          return Promise.resolve('synthetic_access_token')
        },
      },
      engine: { ready: true },
      transport,
      quota,
      random: () => 0,
    })

    chat.start()
    await flushMicrotasks()

    expect(transport.starts).toEqual([0])
    expect(chat.lastResult).toEqual({ outcome: 'stopped', reason: 'auth_revoked' })
    expect(chat.observe().stopped?.reason).toBe('auth_revoked')
    expect(chat.observe()).toMatchObject({
      consecutiveFailures: 1,
      retryBudgetExhausted: false,
    })
    expect(chat.signals().find((signal) => signal.name === CHAT_TRANSPORT_SIGNAL)).toMatchObject({
      status: 'degraded',
      reason: 'auth_revoked',
    })
    // Auth/policy stops remain terminal until the supervisor explicitly runs
    // its two-phase action; resetting lifecycle state never self-restarts one.
    await flushMicrotasks()
    expect(transport.starts).toEqual([0])

    // Production shape from main.ts: the same object, with stop fully settled
    // before start. stop() also has to cancel the old binding watcher now.
    await chat.stop()
    expect(chat.observe().mode).toBe('idle')
    expect(clock.pendingTimerCount).toBe(0)
    chat.start()
    chat.start()
    await flushMicrotasks()

    expect(chat.lastResult).toBeNull()
    expect(chat.observe()).toMatchObject({
      mode: 'grpc',
      stopped: null,
      consecutiveFailures: 0,
      retryBudgetExhausted: false,
      lastError: { kind: 'unauthorized' },
    })
    expect(chat.transportReady()).toBe(true)
    expect(transport.starts).toEqual([0])

    await clock.advance(24_999)
    expect(transport.starts).toEqual([0])
    await clock.advance(1)

    expect(transport.starts).toEqual([0, 25_000])
    expect(transport.requests.map((request) => request.live_chat_id)).toEqual([
      TEST_LIVE_CHAT_ID,
      TEST_LIVE_CHAT_ID,
    ])
    expect(transport.requests.map((request) => request.page_token)).toEqual([undefined, undefined])
    expect(quota.snapshot()).toMatchObject({
      spentUnits: 2,
      byMethod: { 'liveChatMessages.streamList': 2 },
    })
    expect(chat.observe()).toMatchObject({
      mode: 'grpc',
      connected: false,
      stopped: null,
      pageToken: 'token_after_restart',
    })
    expect(chat.signals().find((signal) => signal.name === CHAT_TRANSPORT_SIGNAL)?.status).toBe(
      'ok',
    )

    await chat.stop()
    expect(clock.pendingTimerCount).toBe(0)
  })

  it('restarts READY after an exhausted prior run without losing pacing, checkpoint, or history', async () => {
    const clock = new FakeClock()
    temp = createTempStore({ clock })
    const transport = new VirtualTransport(clock, [
      {
        response: {
          items: [GRPC_MESSAGE],
          next_page_token: 'token_before_restart',
        },
        errorCode: status.UNAVAILABLE,
      },
      { errorCode: status.UNAVAILABLE },
      { response: { items: [], next_page_token: 'token_after_restart' } },
    ])
    const base = testChatConfig({
      grpcStreamMinStartIntervalMs: 5000,
      readyPollIntervalMs: 100,
      reconnect: {
        initialDelayMs: 100,
        maxDelayMs: 100,
        factor: 1,
        jitterRatio: 0,
        maxAttempts: 1,
      },
      fallback: {
        enterAfterConsecutiveFailures: 99,
        retryPrimaryAfterMs: 60_000,
      },
    })
    const quota = new QuotaTracker({ clock })
    const chat = new ChatSource({
      config: base,
      clock,
      inbox: storeInbox(temp.store),
      checkpoints: temp.store,
      parseCommand: testParseCommand,
      auth: fixedTokens(),
      engine: { ready: true },
      transport,
      quota,
      random: () => 0,
    })

    chat.start()
    await flushMicrotasks()
    await clock.advance(5000)

    expect(transport.starts).toEqual([0, 5000])
    expect(chat.observe()).toMatchObject({
      consecutiveFailures: 2,
      retryBudgetExhausted: true,
      pageToken: 'token_before_restart',
      userEvents: { total: 1 },
      reconnect: { count: 0 },
    })

    await chat.stop()
    chat.start()
    await flushMicrotasks()

    // The new run receives a fresh local failure budget, so a READY channel is
    // canonical readiness even with zero new viewer messages. The previous
    // error remains history, while the next quota-bearing start is still paced.
    expect(chat.observe()).toMatchObject({
      mode: 'grpc',
      consecutiveFailures: 0,
      retryBudgetExhausted: false,
      lastError: { kind: 'serverError' },
      pageToken: 'token_before_restart',
      userEvents: { total: 1 },
      reconnect: { count: 0 },
    })
    expect(chat.transportReady()).toBe(true)
    expect(transport.starts).toEqual([0, 5000])

    await clock.advance(4999)
    expect(transport.starts).toEqual([0, 5000])
    await clock.advance(1)

    expect(transport.starts).toEqual([0, 5000, 10_000])
    expect(transport.requests.map((request) => request.page_token)).toEqual([
      undefined,
      'token_before_restart',
      'token_before_restart',
    ])
    expect(chat.observe()).toMatchObject({
      pageToken: 'token_after_restart',
      userEvents: { total: 1 },
      reconnect: {
        count: 1,
        resumedWithToken: true,
        estimatedLostMessages: 0,
      },
    })
    expect(quota.snapshot()).toMatchObject({
      spentUnits: 3,
      byMethod: { 'liveChatMessages.streamList': 3 },
    })

    await chat.stop()
    expect(clock.pendingTimerCount).toBe(0)
  })

  it('keeps empty-end backoff and adds the remaining quota floor before starting', async () => {
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
    expect(h.transport.starts).toEqual([0])
    expect(h.state.observe(null, 'READY').reconnect.wait).toMatchObject({
      reason: 'quota_start_pacing',
      delayMs: 24_000,
    })
    await h.clock.advance(23_999)
    expect(h.transport.starts).toEqual([0])
    await h.clock.advance(1)
    expect(h.transport.starts).toEqual([0, 25_000])

    h.source.stop()
    await running
  })

  it('paces the reviewer response-then-UNAVAILABLE sequence that formerly started at 0, 1000, 2000', async () => {
    const h = createSource([
      {
        response: { items: [], next_page_token: 'token_error_1' },
        errorCode: status.UNAVAILABLE,
      },
      {
        response: { items: [], next_page_token: 'token_error_2' },
        errorCode: status.UNAVAILABLE,
      },
      {
        response: { items: [], next_page_token: 'token_error_3' },
        errorCode: status.UNAVAILABLE,
      },
    ])

    const running = h.source.run()
    await flushMicrotasks()
    expect(h.state.observe('token_error_1', 'READY').reconnect.wait).toMatchObject({
      reason: 'failure_backoff',
      delayMs: 1_000,
    })

    await h.clock.advance(25_000)
    await h.clock.advance(25_000)

    expect(h.transport.starts).toEqual([0, 25_000, 50_000])
    expect(h.transport.requests.map((request) => request.page_token)).toEqual([
      undefined,
      'token_error_1',
      'token_error_2',
    ])
    expect(h.quota.snapshot()).toMatchObject({
      spentUnits: 3,
      byMethod: { 'liveChatMessages.streamList': 3 },
    })
    // Every response resets the streak before its terminal error records one.
    expect(h.state.consecutiveFailures).toBe(1)
    expect(h.state.observe('token_error_3', 'READY').reconnect.wait?.reason).toBe('failure_backoff')

    h.source.stop()
    await running
  })

  it('paces alternating normal, response-error, empty, and token-rejection outcomes without erasing backoff reasons', async () => {
    const h = createSource([
      { response: { items: [], next_page_token: 'token_alt_1' } },
      {
        response: { items: [], next_page_token: 'token_alt_2' },
        errorCode: status.UNAVAILABLE,
      },
      {},
      { response: { items: [], next_page_token: 'token_alt_4' } },
      { errorCode: status.INVALID_ARGUMENT },
      { response: { items: [], next_page_token: 'token_alt_6' } },
    ])

    const running = h.source.run()
    await flushMicrotasks()
    expect(h.state.observe('token_alt_1', 'READY').reconnect.wait?.reason).toBe(
      'quota_start_pacing',
    )

    await h.clock.advance(25_000)
    expect(h.state.observe('token_alt_2', 'READY').reconnect.wait).toMatchObject({
      reason: 'failure_backoff',
      delayMs: 1_000,
    })
    await h.clock.advance(1_000)
    expect(h.state.observe('token_alt_2', 'READY').reconnect.wait).toMatchObject({
      reason: 'quota_start_pacing',
      delayMs: 24_000,
    })
    await h.clock.advance(24_000)
    expect(h.state.observe('token_alt_2', 'READY').reconnect.wait).toMatchObject({
      reason: 'empty_end_backoff',
      delayMs: 1_000,
    })
    await h.clock.advance(1_000)
    expect(h.state.observe('token_alt_2', 'READY').reconnect.wait).toMatchObject({
      reason: 'quota_start_pacing',
      delayMs: 24_000,
    })
    await h.clock.advance(24_000)
    expect(h.state.observe('token_alt_4', 'READY').reconnect.wait?.reason).toBe(
      'quota_start_pacing',
    )
    await h.clock.advance(25_000)
    expect(h.state.observe(null, 'READY').reconnect).toMatchObject({
      tokenRejected: true,
      wait: { reason: 'quota_start_pacing', delayMs: 25_000 },
    })
    await h.clock.advance(25_000)

    expect(h.transport.starts).toEqual([0, 25_000, 50_000, 75_000, 100_000, 125_000])
    expect(
      h.transport.starts.slice(1).map((start, index) => start - h.transport.starts[index]!),
    ).toEqual([25_000, 25_000, 25_000, 25_000, 25_000])
    expect(h.transport.requests.map((request) => request.page_token)).toEqual([
      undefined,
      'token_alt_1',
      'token_alt_2',
      'token_alt_2',
      'token_alt_4',
      undefined,
    ])
    expect(h.quota.snapshot()).toMatchObject({
      spentUnits: 6,
      byMethod: { 'liveChatMessages.streamList': 6 },
    })

    h.source.stop()
    await running
  })
})
