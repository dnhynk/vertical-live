import { describe, expect, it } from 'vitest'

import type { HealthSignal } from '../../health/types.js'
import { FakeClock } from '../../testing/fake-clock.js'
import {
  CHAT_KEEPALIVE_SIGNAL,
  CHAT_RECONNECT_SIGNAL,
  CHAT_TRANSPORT_SIGNAL,
  CHAT_USER_EVENTS_SIGNAL,
  buildChatHealthSignals,
  type ChatObservation,
} from './health.js'
import { ChatSourceState } from './state.js'

/**
 * Spec §9.4(3): transport, keepalive, reconnect count and token, and the last
 * user event are recorded separately — and no amount of silence from viewers is
 * allowed to turn any of them `degraded`.
 */

const KEEPALIVE = { timeMs: 300_000, timeoutMs: 20_000, permitWithoutCalls: false }

function observation(overrides: Partial<ChatObservation> = {}): ChatObservation {
  return {
    mode: 'grpc',
    connected: true,
    channelState: 'READY',
    keepalive: KEEPALIVE,
    lastResponseAtUtc: '2026-08-17T00:00:00.000Z',
    lastResponseAtMonotonicMs: 0,
    consecutiveFailures: 0,
    retryBudgetExhausted: false,
    lastError: null,
    offlineAt: null,
    stopped: null,
    reconnect: {
      count: 0,
      lastAt: null,
      gapMs: null,
      resumedWithToken: null,
      tokenRejected: false,
      reconnectsWithoutToken: 0,
      estimatedDuplicates: 0,
      estimatedLostMessages: 0,
    },
    pageToken: null,
    userEvents: { lastAtUtc: null, lastAtMonotonicMs: null, total: 0 },
    ...overrides,
  }
}

function byName(signals: HealthSignal[], name: string): HealthSignal {
  const signal = signals.find((entry) => entry.name === name)
  if (signal === undefined) throw new Error(`missing signal ${name}`)
  return signal
}

describe('buildChatHealthSignals', () => {
  it('emits the four §9.4(3) signals for one component', () => {
    const signals = buildChatHealthSignals(observation(), new FakeClock())

    expect(signals.map((signal) => signal.name)).toEqual([
      CHAT_TRANSPORT_SIGNAL,
      CHAT_KEEPALIVE_SIGNAL,
      CHAT_RECONNECT_SIGNAL,
      CHAT_USER_EVENTS_SIGNAL,
    ])
    for (const signal of signals) expect(signal.component).toBe('youtube-chat')
  })

  it('stays ok when a connected chat has never seen a user event', () => {
    const clock = new FakeClock()
    clock.advance(6 * 60 * 60 * 1000)
    const signals = buildChatHealthSignals(
      observation({ userEvents: { lastAtUtc: null, lastAtMonotonicMs: null, total: 0 } }),
      clock,
    )

    // The whole point of §9.4(3): "사용자 메시지 무수신만으로 degraded 판정하지 않음".
    expect(byName(signals, CHAT_USER_EVENTS_SIGNAL).status).toBe('ok')
    expect(byName(signals, CHAT_TRANSPORT_SIGNAL).status).toBe('ok')
    expect(byName(signals, CHAT_KEEPALIVE_SIGNAL).status).toBe('ok')
    expect(byName(signals, CHAT_USER_EVENTS_SIGNAL).detail['lastUserEventAt']).toBeNull()
  })

  it('stays ok after six silent hours on a live connection', () => {
    const clock = new FakeClock()
    const signals0 = buildChatHealthSignals(
      observation({
        userEvents: { lastAtUtc: '2026-08-17T00:00:00.000Z', lastAtMonotonicMs: 0, total: 12 },
      }),
      clock,
    )
    clock.advance(6 * 60 * 60 * 1000)
    const signals1 = buildChatHealthSignals(
      observation({
        userEvents: { lastAtUtc: '2026-08-17T00:00:00.000Z', lastAtMonotonicMs: 0, total: 12 },
      }),
      clock,
    )

    expect(byName(signals0, CHAT_USER_EVENTS_SIGNAL).status).toBe('ok')
    expect(byName(signals1, CHAT_USER_EVENTS_SIGNAL).status).toBe('ok')
    expect(byName(signals1, CHAT_USER_EVENTS_SIGNAL).detail['msSinceLastUserEvent']).toBe(
      6 * 60 * 60 * 1000,
    )
  })

  it('reports a reconnecting transport as unknown, not degraded', () => {
    const signals = buildChatHealthSignals(
      observation({ connected: false, consecutiveFailures: 1, channelState: 'CONNECTING' }),
      new FakeClock(),
    )

    const transport = byName(signals, CHAT_TRANSPORT_SIGNAL)
    expect(transport.status).toBe('unknown')
    expect(transport.reason).toBe('reconnecting')
  })

  it('reports an exhausted retry budget and a stop as degraded', () => {
    const exhausted = buildChatHealthSignals(
      observation({ connected: false, consecutiveFailures: 9, retryBudgetExhausted: true }),
      new FakeClock(),
    )
    const stopped = buildChatHealthSignals(
      observation({
        connected: false,
        stopped: { reason: 'permission_denied', at: '2026-08-17T00:00:00.000Z' },
      }),
      new FakeClock(),
    )

    expect(byName(exhausted, CHAT_TRANSPORT_SIGNAL).status).toBe('degraded')
    expect(byName(exhausted, CHAT_TRANSPORT_SIGNAL).reason).toBe('retry_budget_exhausted')
    expect(byName(stopped, CHAT_TRANSPORT_SIGNAL).reason).toBe('permission_denied')
  })

  it('reports a failing channel through the keepalive signal', () => {
    const signals = buildChatHealthSignals(
      observation({ connected: false, channelState: 'TRANSIENT_FAILURE' }),
      new FakeClock(),
    )

    const keepalive = byName(signals, CHAT_KEEPALIVE_SIGNAL)
    expect(keepalive.status).toBe('degraded')
    expect(keepalive.detail['keepaliveTimeMs']).toBe(KEEPALIVE.timeMs)
  })

  it('has no keepalive observation on the REST path', () => {
    const signals = buildChatHealthSignals(
      observation({ mode: 'rest', channelState: null }),
      new FakeClock(),
    )

    expect(byName(signals, CHAT_KEEPALIVE_SIGNAL).status).toBe('unknown')
    expect(byName(signals, CHAT_KEEPALIVE_SIGNAL).reason).toBe('no_grpc_channel')
  })

  it('records the reconnect count, the token and the duplicate estimate', () => {
    const signals = buildChatHealthSignals(
      observation({
        pageToken: 'token_test_health',
        reconnect: {
          count: 3,
          lastAt: '2026-08-17T00:00:05.000Z',
          gapMs: 1200,
          resumedWithToken: true,
          tokenRejected: false,
          reconnectsWithoutToken: 0,
          estimatedDuplicates: 4,
          estimatedLostMessages: 0,
        },
      }),
      new FakeClock(),
    )

    const reconnect = byName(signals, CHAT_RECONNECT_SIGNAL)
    expect(reconnect.status).toBe('ok')
    expect(reconnect.detail).toMatchObject({
      count: 3,
      gapMs: 1200,
      estimatedDuplicates: 4,
      estimatedLostMessages: 0,
      lastPageToken: 'token_test_health',
    })
  })

  it('flags a reconnect that lost its resume token', () => {
    const signals = buildChatHealthSignals(
      observation({
        reconnect: {
          count: 1,
          lastAt: '2026-08-17T00:00:05.000Z',
          gapMs: 40,
          resumedWithToken: false,
          tokenRejected: true,
          reconnectsWithoutToken: 1,
          estimatedDuplicates: 0,
          estimatedLostMessages: null,
        },
      }),
      new FakeClock(),
    )

    const reconnect = byName(signals, CHAT_RECONNECT_SIGNAL)
    expect(reconnect.status).toBe('degraded')
    expect(reconnect.reason).toBe('resumed_without_token')
    // The gap is unknown, and the signal says so rather than guessing a number.
    expect(reconnect.detail['estimatedLostMessages']).toBeNull()
  })
})

describe('ChatSourceState', () => {
  it('counts reconnects only after the first connection', () => {
    const clock = new FakeClock()
    const state = new ChatSourceState(clock, KEEPALIVE)

    state.connectAttempt(false)
    state.recordResponse()
    expect(state.observe(null, null).reconnect.count).toBe(0)

    state.recordDisconnect()
    clock.advance(250)
    state.connectAttempt(true)
    const observed = state.observe('token_x', 'READY')
    expect(observed.reconnect.count).toBe(1)
    expect(observed.reconnect.gapMs).toBe(250)
    expect(observed.reconnect.resumedWithToken).toBe(true)
  })

  it('keeps the duplicate estimate of the last connection that delivered data', () => {
    const state = new ChatSourceState(new FakeClock(), KEEPALIVE)

    state.connectAttempt(false)
    state.recordResponse()
    state.recordCommit({ duplicates: 2, dropped: 0, userEvents: 1, userEventAt: 'x' })
    state.recordDisconnect()
    // Two dials that never receive anything must not erase the measurement.
    state.connectAttempt(true)
    state.recordFailure({ kind: 'serverError', action: 'retry', retryable: true }, 8)
    state.connectAttempt(true)

    expect(state.observe(null, null).reconnect.estimatedDuplicates).toBe(2)
  })
})
