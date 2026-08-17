import type { Clock } from '../../clock.js'
import type { HealthSignal } from '../../health/types.js'
import type { FaultAction } from '../auth/errors.js'
import type { ApiErrorKind } from '../quota/classify.js'
import type { ChatKeepaliveConfig } from './config.js'

/**
 * Chat source health signals (spec §9.4(3)): transport state, keepalive,
 * reconnect count and last token, and the time of the last user event — each
 * recorded separately.
 *
 * The rule the spec states explicitly, and the reason `user_events` is a signal
 * of its own: **silence is not a fault.** A chat nobody is typing in produces no
 * messages, and a world that ran fine for an hour without a viewer is exactly
 * what §2.1 asks for. So `youtube.chat.user_events` is *always* `ok` and only
 * carries the last-event time as detail; nothing in this file lets an empty
 * chat turn any signal `degraded`. What can turn a signal `degraded` is an
 * observation about the transport itself: a call the server refuses, a channel
 * in `TRANSIENT_FAILURE`, a retry budget that ran out, or a reconnect that had
 * to give up its resume token.
 *
 * These are reports, not verdicts. T12's supervisor decides what a combination
 * means for the broadcast.
 */

export const CHAT_TRANSPORT_SIGNAL = 'youtube.chat.transport'
export const CHAT_KEEPALIVE_SIGNAL = 'youtube.chat.keepalive'
export const CHAT_RECONNECT_SIGNAL = 'youtube.chat.reconnect'
export const CHAT_USER_EVENTS_SIGNAL = 'youtube.chat.user_events'

export const CHAT_HEALTH_SIGNAL_NAMES = [
  CHAT_TRANSPORT_SIGNAL,
  CHAT_KEEPALIVE_SIGNAL,
  CHAT_RECONNECT_SIGNAL,
  CHAT_USER_EVENTS_SIGNAL,
] as const

/** Which path is currently expected to deliver messages. */
export type ChatMode = 'idle' | 'grpc' | 'rest'

export interface ChatErrorObservation {
  readonly kind: ApiErrorKind
  readonly action: FaultAction
  readonly at: string
  /** gRPC status code or HTTP status, whichever the failure carried. */
  readonly statusCode: number | null
  readonly reason: string | null
}

export interface ChatReconnectObservation {
  /** How many times a stream/poll had to be re-established (spec §9.4(3)). */
  readonly count: number
  readonly lastAt: string | null
  /** Monotonic milliseconds between losing the stream and receiving again. */
  readonly gapMs: number | null
  /** Whether the last (re)connect presented a resume token (spec §11). */
  readonly resumedWithToken: boolean | null
  /** The server refused our token, so the resume point was lost. */
  readonly tokenRejected: boolean
  /**
   * Messages the inbox already had after the last reconnect — measured, not
   * guessed: `commitIngestBatch` reports a duplicate per event key (spec §11).
   */
  readonly estimatedDuplicates: number
  /**
   * Messages the reconnect may have skipped. `0` when the stream resumed from
   * our token (or started cold, where nothing preceded us), `null` when the
   * token was lost or refused — the size of that gap is genuinely unknown and
   * is not invented here.
   */
  readonly estimatedLostMessages: number | null
}

export interface ChatUserEventObservation {
  readonly lastAtUtc: string | null
  readonly lastAtMonotonicMs: number | null
  readonly total: number
}

/** Everything the source knows about itself at one instant. */
export interface ChatObservation {
  readonly mode: ChatMode
  readonly connected: boolean
  /** gRPC channel connectivity; `null` on the REST path. */
  readonly channelState: string | null
  readonly keepalive: ChatKeepaliveConfig
  readonly lastResponseAtUtc: string | null
  readonly lastResponseAtMonotonicMs: number | null
  readonly consecutiveFailures: number
  /** Retries passed `reconnect.maxAttempts`; the source keeps trying slowly. */
  readonly retryBudgetExhausted: boolean
  readonly lastError: ChatErrorObservation | null
  /** `offline_at` from the last response that carried one (spec §9.2). */
  readonly offlineAt: string | null
  /** Set when the source stopped on purpose and needs a human or T12. */
  readonly stopped: { readonly reason: string; readonly at: string } | null
  readonly reconnect: ChatReconnectObservation
  /** Last `nextPageToken` (a pagination cursor, not a credential; §9.4(3)). */
  readonly pageToken: string | null
  readonly userEvents: ChatUserEventObservation
}

export function buildChatHealthSignals(
  observation: ChatObservation,
  clock: Clock,
): HealthSignal[] {
  const observedAtUtc = clock.nowUtcIso()
  const observedAtMonotonicMs = clock.monotonicMs()
  const base = { component: 'youtube-chat' as const, observedAtUtc, observedAtMonotonicMs }

  return [
    { ...base, name: CHAT_TRANSPORT_SIGNAL, ...transport(observation) },
    { ...base, name: CHAT_KEEPALIVE_SIGNAL, ...keepalive(observation, observedAtMonotonicMs) },
    { ...base, name: CHAT_RECONNECT_SIGNAL, ...reconnect(observation) },
    { ...base, name: CHAT_USER_EVENTS_SIGNAL, ...userEvents(observation, observedAtMonotonicMs) },
  ]
}

type SignalBody = Pick<HealthSignal, 'status' | 'detail'> & { reason?: string }

function transport(observation: ChatObservation): SignalBody {
  const detail = {
    mode: observation.mode,
    connected: observation.connected,
    consecutiveFailures: observation.consecutiveFailures,
    retryBudgetExhausted: observation.retryBudgetExhausted,
    lastErrorKind: observation.lastError?.kind ?? null,
    lastErrorAction: observation.lastError?.action ?? null,
    lastErrorAt: observation.lastError?.at ?? null,
    lastErrorStatus: observation.lastError?.statusCode ?? null,
    lastResponseAt: observation.lastResponseAtUtc,
    streamOfflineAt: observation.offlineAt,
  }
  if (observation.stopped !== null) {
    return { status: 'degraded', reason: observation.stopped.reason, detail }
  }
  if (observation.retryBudgetExhausted) {
    return { status: 'degraded', reason: 'retry_budget_exhausted', detail }
  }
  if (observation.connected) return { status: 'ok', detail }
  if (observation.mode === 'idle') return { status: 'unknown', reason: 'not_started', detail }
  return { status: 'unknown', reason: 'reconnecting', detail }
}

function keepalive(observation: ChatObservation, nowMonotonicMs: number): SignalBody {
  const detail = {
    keepaliveTimeMs: observation.keepalive.timeMs,
    keepaliveTimeoutMs: observation.keepalive.timeoutMs,
    keepalivePermitWithoutCalls: observation.keepalive.permitWithoutCalls,
    channelState: observation.channelState,
    // Time since the last *response* of any kind. It is reported, never judged:
    // a quiet chat legitimately sends nothing for a long time.
    msSinceLastResponse:
      observation.lastResponseAtMonotonicMs === null
        ? null
        : nowMonotonicMs - observation.lastResponseAtMonotonicMs,
  }
  if (observation.mode !== 'grpc' || observation.channelState === null) {
    return { status: 'unknown', reason: 'no_grpc_channel', detail }
  }
  if (observation.channelState === 'TRANSIENT_FAILURE') {
    return { status: 'degraded', reason: 'channel_transient_failure', detail }
  }
  if (observation.channelState === 'SHUTDOWN') {
    return { status: 'unknown', reason: 'channel_shutdown', detail }
  }
  return { status: 'ok', detail }
}

function reconnect(observation: ChatObservation): SignalBody {
  const detail = {
    count: observation.reconnect.count,
    lastAt: observation.reconnect.lastAt,
    gapMs: observation.reconnect.gapMs,
    resumedWithToken: observation.reconnect.resumedWithToken,
    estimatedDuplicates: observation.reconnect.estimatedDuplicates,
    estimatedLostMessages: observation.reconnect.estimatedLostMessages,
    // The reconnect cursor §9.4(3) asks to record. It authorizes nothing: it
    // names a position in one chat's message list, and `/health` is loopback.
    lastPageToken: observation.pageToken,
  }
  if (observation.reconnect.tokenRejected) {
    return { status: 'degraded', reason: 'resumed_without_token', detail }
  }
  return { status: 'ok', detail }
}

function userEvents(observation: ChatObservation, nowMonotonicMs: number): SignalBody {
  // Always `ok`. Spec §9.4(3): "사용자 메시지 무수신만으로 degraded 판정하지 않음".
  return {
    status: 'ok',
    detail: {
      lastUserEventAt: observation.userEvents.lastAtUtc,
      msSinceLastUserEvent:
        observation.userEvents.lastAtMonotonicMs === null
          ? null
          : nowMonotonicMs - observation.userEvents.lastAtMonotonicMs,
      totalUserEvents: observation.userEvents.total,
    },
  }
}
