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
 * in `TRANSIENT_FAILURE`, or a retry budget that ran out.
 *
 * These are reports, not verdicts. T12's supervisor decides what a combination
 * means for the broadcast.
 */

export const CHAT_TRANSPORT_SIGNAL = 'youtube.chat.transport'
export const CHAT_KEEPALIVE_SIGNAL = 'youtube.chat.keepalive'
export const CHAT_RECONNECT_SIGNAL = 'youtube.chat.reconnect'
export const CHAT_USER_EVENTS_SIGNAL = 'youtube.chat.user_events'
/** Emitted **only** while the consent gate is open (BOARD D-9, T20b). */
export const CHAT_CONSENT_SIGNAL = 'youtube.chat.consent'

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

/**
 * What the source has actually observed about losing and regaining its input.
 *
 * A reconnect here means "a path that was delivering stopped, and a later
 * response proved it recovered". Dial attempts, retries inside one outage and
 * ordinary REST polls are none of those, so they change nothing (review round 1,
 * M3). The four per-reconnect fields below stay `null` until the first one
 * happens; `count === 0` is what says "nothing to report yet".
 */
export interface ChatReconnectObservation {
  /** Proven recoveries of a delivering path (spec §9.4(3)). */
  readonly count: number
  readonly lastAt: string | null
  /** Measured monotonic milliseconds from the loss to the response that ended it. */
  readonly gapMs: number | null
  /** Whether the attempt that recovered presented a resume token (spec §11). */
  readonly resumedWithToken: boolean | null
  /** The server refused our token at least once, so a resume point was lost. */
  readonly tokenRejected: boolean
  /** How many times, and when the last one was — history, not a verdict (T29). */
  readonly tokenRejections: number
  readonly lastTokenRejectedAt: string | null
  /** Recoveries that had no token to present — each one an unbounded gap. */
  readonly reconnectsWithoutToken: number
  /**
   * Messages the inbox already had since the last recovery — measured, not
   * guessed: `commitIngestBatch` reports a duplicate per event key (spec §11).
   */
  readonly estimatedDuplicates: number
  /**
   * Messages the **last** reconnect may have skipped. `0` only once a response
   * has proved the stream resumed from our token; `null` when the recovering
   * attempt had none (the gap is genuinely unbounded) and before any reconnect
   * has happened. No number here is ever inferred from an attempt alone.
   */
  readonly estimatedLostMessages: number | null
  /** Active reconnect wait, distinguishing quota pacing from branch backoff (T47). */
  readonly wait?: ChatReconnectWaitObservation | null
}

export type ChatReconnectWaitReason = 'quota_start_pacing' | 'empty_end_backoff' | 'failure_backoff'

export interface ChatReconnectWaitObservation {
  readonly reason: ChatReconnectWaitReason
  readonly startedAt: string
  /** Monotonic start, so `transport()` can tell a running wait from a stuck one. */
  readonly startedAtMonotonicMs: number
  readonly delayMs: number
}

/**
 * How far past its own planned delay a pacing wait may run before it stops
 * counting as "waiting by design".
 *
 * A wait that is still inside its delay is the source doing exactly what it was
 * configured to do. A wait that has overrun is a source that is stuck, and that
 * has to look unobservable again or nothing would ever notice it.
 *
 * `provisional` (BOARD A-15): a margin for timer and scheduling slack, not a
 * measured threshold.
 */
export const PACING_OVERRUN_GRACE_MS = 5_000

export interface ChatUserEventObservation {
  readonly lastAtUtc: string | null
  readonly lastAtMonotonicMs: number | null
  readonly total: number
}

/**
 * What the source did with the consent decisions it carried (BOARD D-9, T20b).
 *
 * Anonymous integers: the source never learns whose decision any of them was.
 * `withdrawalRetrying` is the one that means something is *wrong* — a `LEAVE`
 * whose deletion could not be applied, whose batch was therefore rolled back,
 * and which has not succeeded since (review round 1, B3).
 */
export interface ChatConsentObservation {
  readonly joined: number
  readonly left: number
  readonly failures: number
  readonly lastFailureKind: string | null
  readonly lastFailureAt: string | null
  readonly withdrawalRetrying: boolean
}

/** Everything the source knows about itself at one instant. */
export interface ChatObservation {
  readonly mode: ChatMode
  /**
   * The chat this source is reading. A segment rollover moves the binding
   * (BOARD D-21), and a listener left on the previous broadcast still reports a
   * `READY` channel — so which chat it is on has to be visible, or a swap can
   * break the input path while the signal says `ok` (measured 2026-08-23).
   */
  readonly liveChatId: string | null
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
  /**
   * Consent counters. Absent or `null` while the gate is closed — and that is
   * what keeps the closed configuration's `/health` byte-for-byte what it was
   * before T20b, because no consent signal is built from it (review round 1, M1).
   */
  readonly consent?: ChatConsentObservation | null
}

export function buildChatHealthSignals(observation: ChatObservation, clock: Clock): HealthSignal[] {
  const observedAtUtc = clock.nowUtcIso()
  const observedAtMonotonicMs = clock.monotonicMs()
  const base = { component: 'youtube-chat' as const, observedAtUtc, observedAtMonotonicMs }

  const signals: HealthSignal[] = [
    { ...base, name: CHAT_TRANSPORT_SIGNAL, ...transport(observation, observedAtMonotonicMs) },
    { ...base, name: CHAT_KEEPALIVE_SIGNAL, ...keepalive(observation, observedAtMonotonicMs) },
    { ...base, name: CHAT_RECONNECT_SIGNAL, ...reconnect(observation) },
    { ...base, name: CHAT_USER_EVENTS_SIGNAL, ...userEvents(observation, observedAtMonotonicMs) },
  ]
  // Appended, never inserted: a closed gate produces exactly the four signals it
  // produced before T20b, in the same order.
  const consentObservation = observation.consent ?? null
  if (consentObservation !== null) {
    signals.push({ ...base, name: CHAT_CONSENT_SIGNAL, ...consent(consentObservation) })
  }
  return signals
}

type SignalBody = Pick<HealthSignal, 'status' | 'detail'> & { reason?: string }

/**
 * Is the input path up? — which is **not** the same question as "has it been
 * sent anything?" (T28).
 *
 * The first broadcast found the difference the hard way: a live chat nobody was
 * typing in sent no message page for over twenty seconds, `connected` never
 * stood, the family escalated to `unobservable`, and the restart that followed
 * closed the transport and started the wait over — so the run could not
 * converge and ended in `safe_stopped` with five of six required families `ok`.
 * Spec §2.1 says a world with zero viewers is the normal case, so a quiet chat
 * is a state, not a fault; the keepalive note below has said as much all along.
 *
 * So a gRPC channel that reports `READY` is a connected transport even before
 * its first response: the HTTP/2 connection to the endpoint is up, and a call
 * the server refuses shows up as a failure streak rather than as silence — which
 * is why the streak is still disqualifying here. On REST the question never
 * arises: every poll that answers is a response, so the poller keeping its
 * cadence is already `connected`.
 *
 * **A source waiting out its own quota pacing floor is up too** (T54). The floor
 * exists because `liveChatMessages.streamList` refuses somewhere near a thousand
 * calls a day, and honouring it means holding the stream closed between starts.
 * Reporting that as `unknown` made the closed half of every cycle look like an
 * outage: on 2026-08-29 a 90s floor against a 30s `signalStaleAfterMs` had the
 * supervisor escalate `chat_transport` and spend one of `chat-source`'s three
 * restarts on a source whose own health said `consecutiveFailures: 0`,
 * `lastErrorKind: null`, `waitReason: quota_start_pacing`. Restarting it only
 * reset the pacing clock and started the cycle again — the same shape as the
 * T28 bug above, where a judgement fired before the thing it was waiting on was
 * due.
 *
 * So a pacing wait that is still inside its own delay reports `ok`, with the
 * reason naming it, and the moment it overruns that delay by
 * `PACING_OVERRUN_GRACE_MS` it goes back to `unknown` — a source stuck in a wait
 * is a real fault and still has to be visible.
 */
function transport(observation: ChatObservation, nowMonotonicMs: number): SignalBody {
  const detail = {
    mode: observation.mode,
    liveChatId: observation.liveChatId,
    connected: observation.connected,
    channelState: observation.channelState,
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
  if (observation.consecutiveFailures === 0 && isPacingByDesign(observation, nowMonotonicMs)) {
    return { status: 'ok', reason: 'quota_start_pacing', detail }
  }
  // Connected, waiting for a first message that a quiet chat may never send.
  // `channelState` is non-null only on the gRPC path, so this cannot fire while
  // the poller is between attempts.
  if (observation.channelState === 'READY' && observation.consecutiveFailures === 0) {
    return { status: 'ok', detail }
  }
  return { status: 'unknown', reason: 'reconnecting', detail }
}

/** A `quota_start_pacing` wait that is running and has not overrun its delay. */
function isPacingByDesign(observation: ChatObservation, nowMonotonicMs: number): boolean {
  const wait = observation.reconnect.wait ?? null
  if (wait === null || wait.reason !== 'quota_start_pacing') return false
  const elapsedMs = nowMonotonicMs - wait.startedAtMonotonicMs
  return elapsedMs >= 0 && elapsedMs <= wait.delayMs + PACING_OVERRUN_GRACE_MS
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

/**
 * What has happened to this source's continuity — recorded, never judged (T29).
 *
 * A refused resume token used to make this `degraded`, and nothing ever cleared
 * the flag. `chat_transport` degrades on any one of its signals, a degraded
 * family asks for a `chat-source` restart, the restart reuses the same
 * `ChatSourceState` so the flag survived it, and a restart budget only comes
 * back when the family is healthy — so one refusal ended the run in
 * `safe_stopped`, by the same route T28 took.
 *
 * Removing the verdict rather than adding an expiry is the point. A lost resume
 * token means messages were skipped: a gap that has *already happened*, which a
 * restart cannot recover and can only widen by opening yet another connection.
 * Nothing here is a fault a component restart fixes. A transport that keeps
 * being refused is still a fault, and it is reported where it belongs — every
 * refusal also records a failure, so a repeating one climbs
 * `consecutiveFailures` and shows up on `youtube.chat.transport`.
 */
function reconnect(observation: ChatObservation): SignalBody {
  const detail = {
    count: observation.reconnect.count,
    lastAt: observation.reconnect.lastAt,
    gapMs: observation.reconnect.gapMs,
    resumedWithToken: observation.reconnect.resumedWithToken,
    tokenRejected: observation.reconnect.tokenRejected,
    tokenRejections: observation.reconnect.tokenRejections,
    lastTokenRejectedAt: observation.reconnect.lastTokenRejectedAt,
    reconnectsWithoutToken: observation.reconnect.reconnectsWithoutToken,
    estimatedDuplicates: observation.reconnect.estimatedDuplicates,
    estimatedLostMessages: observation.reconnect.estimatedLostMessages,
    waitReason: observation.reconnect.wait?.reason ?? null,
    waitStartedAt: observation.reconnect.wait?.startedAt ?? null,
    waitDelayMs: observation.reconnect.wait?.delayMs ?? null,
    // The reconnect cursor §9.4(3) asks to record. It authorizes nothing: it
    // names a position in one chat's message list, and `/health` is loopback.
    lastPageToken: observation.pageToken,
  }
  return { status: 'ok', detail }
}

/**
 * The consent decisions this source applied, and the one state that is a fault.
 *
 * A failed `JOIN` or name refresh is reported but not `degraded`: nothing was
 * stored, the viewer can send the command again, and the batch went through. A
 * `LEAVE` that could not be applied *is* `degraded` until a later commit proves
 * the retry landed — until then a viewer has asked to be deleted and has not
 * been (spec §12.4, [S41] III.E.4.g).
 */
function consent(observation: ChatConsentObservation): SignalBody {
  const detail = {
    joined: observation.joined,
    left: observation.left,
    failures: observation.failures,
    lastFailureKind: observation.lastFailureKind,
    lastFailureAt: observation.lastFailureAt,
    withdrawalRetrying: observation.withdrawalRetrying,
  }
  if (observation.withdrawalRetrying) {
    return { status: 'degraded', reason: 'consent_withdrawal_retrying', detail }
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
