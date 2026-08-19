import type { Clock } from '../../clock.js'
import type { ApiErrorClassification } from '../quota/classify.js'
import type { ChatKeepaliveConfig } from './config.js'
import type {
  ChatConsentObservation,
  ChatErrorObservation,
  ChatMode,
  ChatObservation,
  ChatReconnectObservation,
} from './health.js'
import type { ConsentFailure } from './sink.js'

/**
 * The observations both source paths write and the health signals read
 * (spec §9.4(3), §11).
 *
 * It is deliberately a plain mutable record rather than an event bus: gRPC and
 * REST are two shapes of one source, and the reconnect count, the resume token
 * and the last user event have to be continuous across a fallback switch —
 * otherwise a switch would look like a fresh, healthy start.
 *
 * **Every reconnect number is measured, never inferred** (§9.4(3), §11), which
 * fixes what review round 1 found. The rules, in one place:
 *
 * - An *outage* starts only when a source that had been receiving stops
 *   receiving (`recordDisconnect`). A cold start that dials three times before
 *   its first response is not an outage: there was no working path to lose, and
 *   `transport` already reports that state as `unknown / reconnecting`.
 * - A *reconnect* is counted when a response actually arrives during an outage —
 *   not when a dial is attempted, and not once per REST poll. An attempt that
 *   fails proves nothing, so it changes nothing.
 * - `gapMs` is the measured interval between the loss and the response that
 *   ended it, and the outage clock is cleared there rather than left running.
 * - `resumedWithToken` and `estimatedLostMessages` are set from the attempt that
 *   produced that response, so "resumed from our token, therefore nothing was
 *   skipped" is only ever claimed after the server has answered it. Without a
 *   token the gap is unbounded and the estimate stays `null`.
 * - Before the first reconnect, all four are `null`: there is nothing to report,
 *   and `count === 0` says so.
 */
export class ChatSourceState {
  readonly #clock: Clock
  readonly #keepalive: ChatKeepaliveConfig

  #mode: ChatMode = 'idle'
  #connected = false
  #lastResponseAtUtc: string | null = null
  #lastResponseAtMonotonicMs: number | null = null
  #consecutiveFailures = 0
  #retryBudgetExhausted = false
  #lastError: ChatErrorObservation | null = null
  #stopped: { reason: string; at: string } | null = null
  /** Monotonic start of the current outage; `null` while none is in progress. */
  #outageSinceMonotonicMs: number | null = null
  /** A response has arrived at some point, so there is a path that can be lost. */
  #everReceived = false
  /** Whether the attempt now in flight presented a resume token. */
  #attemptWithToken: boolean | null = null
  #offlineAt: string | null = null

  #reconnectCount = 0
  #reconnectLastAt: string | null = null
  #reconnectGapMs: number | null = null
  #resumedWithToken: boolean | null = null
  #tokenRejected = false
  #reconnectsWithoutToken = 0
  #duplicatesSinceReconnect = 0
  #estimatedLostMessages: number | null = null

  #userEventLastAtUtc: string | null = null
  #userEventLastAtMonotonicMs: number | null = null
  #userEventTotal = 0
  #droppedItems = 0

  /** Consent counters, kept only while the gate is open; see `#consentOpen`. */
  readonly #consentOpen: boolean
  #consentJoined = 0
  #consentLeft = 0
  #consentFailures = 0
  #consentLastFailure: { kind: string; at: string } | null = null
  #consentWithdrawalPending = false

  /**
   * `consentGateOpen` decides whether this source reports consent at all. Closed,
   * `observe()` carries no consent field and `/health` gains no signal, so the
   * closed configuration's output is byte-for-byte what it was before T20b
   * (review round 1, M1 applied to the source's own surface).
   */
  constructor(clock: Clock, keepalive: ChatKeepaliveConfig, consentGateOpen = false) {
    this.#clock = clock
    this.#keepalive = keepalive
    this.#consentOpen = consentGateOpen
  }

  get mode(): ChatMode {
    return this.#mode
  }

  get consecutiveFailures(): number {
    return this.#consecutiveFailures
  }

  get stopped(): boolean {
    return this.#stopped !== null
  }

  get droppedItems(): number {
    return this.#droppedItems
  }

  setMode(mode: ChatMode): void {
    this.#mode = mode
    if (mode === 'idle') this.#connected = false
  }

  /**
   * A request is about to be sent — one gRPC stream, or one REST poll.
   *
   * It only remembers whether this attempt carries a resume token. Nothing is
   * counted here: an attempt is not a reconnect until the server answers it,
   * and the REST poller calls this on every poll (review round 1, M3).
   */
  connectAttempt(withToken: boolean): void {
    this.#attemptWithToken = withToken
  }

  /** The connection is live: a response arrived (possibly with zero items). */
  recordResponse(): void {
    if (this.#outageSinceMonotonicMs !== null) this.#endOutage()
    this.#everReceived = true
    this.#connected = true
    this.#consecutiveFailures = 0
    this.#retryBudgetExhausted = false
    this.#lastResponseAtUtc = this.#clock.nowUtcIso()
    this.#lastResponseAtMonotonicMs = this.#clock.monotonicMs()
  }

  /**
   * A response ended an outage, so — and only so — a reconnect happened. Every
   * number below is read off that fact rather than assumed at dial time.
   */
  #endOutage(): void {
    const startedAtMs = this.#outageSinceMonotonicMs
    this.#outageSinceMonotonicMs = null
    this.#reconnectCount += 1
    this.#reconnectLastAt = this.#clock.nowUtcIso()
    this.#reconnectGapMs = startedAtMs === null ? null : this.#clock.monotonicMs() - startedAtMs
    const withToken = this.#attemptWithToken === true
    this.#resumedWithToken = withToken
    // Resumed from our token: the server continues where we left off, so the
    // skipped count is a measured 0. Without one, the gap is unbounded and no
    // number here would be anything but invention.
    this.#estimatedLostMessages = withToken ? 0 : null
    if (!withToken) this.#reconnectsWithoutToken += 1
    // The duplicate estimate belongs to the connection that recovered, so it
    // starts again here — after the failed dials in between, not during them.
    this.#duplicatesSinceReconnect = 0
  }

  recordCommit(outcome: {
    duplicates: number
    dropped: number
    userEvents: number
    userEventAt: string | null
    consentJoined?: number
    consentLeft?: number
  }): void {
    this.#duplicatesSinceReconnect += outcome.duplicates
    this.#droppedItems += outcome.dropped
    if (outcome.userEventAt !== null) {
      this.#userEventLastAtUtc = outcome.userEventAt
      this.#userEventLastAtMonotonicMs = this.#clock.monotonicMs()
      this.#userEventTotal += outcome.userEvents
    }
    this.#consentJoined += outcome.consentJoined ?? 0
    this.#consentLeft += outcome.consentLeft ?? 0
    // A batch only commits when no withdrawal failed inside it (the sink rolls
    // back instead), so a commit is the evidence that the retry got through.
    this.#consentWithdrawalPending = false
  }

  /**
   * One consent decision the ingest path could not apply (review round 1, B3).
   *
   * Counted here rather than in a return value nobody reads, so it reaches
   * `/health`; a withdrawal additionally marks the source as retrying, which is
   * the only consent state that is a *fault* — the batch was rolled back and the
   * deletion has not happened yet.
   */
  recordConsentFailure(failure: ConsentFailure): void {
    this.#consentFailures += 1
    this.#consentLastFailure = { kind: failure.kind, at: this.#clock.nowUtcIso() }
    if (failure.kind === 'withdrawal') this.#consentWithdrawalPending = true
  }

  /**
   * The source stopped receiving: a gRPC stream ended or failed, or a REST poll
   * failed. It starts the outage clock **once**, and only for a path that had
   * been delivering: repeated failures inside one outage keep the original
   * start, so the gap that is finally reported is the real one rather than the
   * time since the most recent retry.
   */
  recordDisconnect(): void {
    this.#connected = false
    if (this.#everReceived && this.#outageSinceMonotonicMs === null) {
      this.#outageSinceMonotonicMs = this.#clock.monotonicMs()
    }
  }

  recordFailure(classification: ApiErrorClassification, maxAttempts: number): void {
    this.#consecutiveFailures += 1
    this.#retryBudgetExhausted = this.#consecutiveFailures > maxAttempts
    this.#lastError = {
      kind: classification.kind,
      action: classification.action,
      at: this.#clock.nowUtcIso(),
      statusCode: classification.grpcCode ?? classification.httpStatus ?? null,
      reason: classification.reason ?? null,
    }
  }

  /**
   * The response said the underlying livestream is offline (`offline_at`). It
   * is recorded and reported; deciding what it means for the broadcast is
   * T10/T12's business (spec §9.2).
   */
  recordOffline(at: string): void {
    this.#offlineAt = at
  }

  /** The server refused our resume token; the resume point is gone (spec §11). */
  recordTokenRejected(): void {
    this.#tokenRejected = true
    this.#estimatedLostMessages = null
  }

  recordStop(reason: string): void {
    this.#stopped = { reason, at: this.#clock.nowUtcIso() }
    this.#connected = false
  }

  clearStop(): void {
    this.#stopped = null
  }

  observe(pageToken: string | null, channelState: string | null): ChatObservation {
    const reconnect: ChatReconnectObservation = {
      count: this.#reconnectCount,
      lastAt: this.#reconnectLastAt,
      gapMs: this.#reconnectGapMs,
      resumedWithToken: this.#resumedWithToken,
      tokenRejected: this.#tokenRejected,
      reconnectsWithoutToken: this.#reconnectsWithoutToken,
      estimatedDuplicates: this.#duplicatesSinceReconnect,
      estimatedLostMessages: this.#estimatedLostMessages,
    }
    const consent: ChatConsentObservation | null = this.#consentOpen
      ? {
          joined: this.#consentJoined,
          left: this.#consentLeft,
          failures: this.#consentFailures,
          lastFailureKind: this.#consentLastFailure?.kind ?? null,
          lastFailureAt: this.#consentLastFailure?.at ?? null,
          withdrawalRetrying: this.#consentWithdrawalPending,
        }
      : null
    return {
      mode: this.#mode,
      connected: this.#connected,
      channelState,
      keepalive: this.#keepalive,
      lastResponseAtUtc: this.#lastResponseAtUtc,
      lastResponseAtMonotonicMs: this.#lastResponseAtMonotonicMs,
      consecutiveFailures: this.#consecutiveFailures,
      retryBudgetExhausted: this.#retryBudgetExhausted,
      lastError: this.#lastError,
      offlineAt: this.#offlineAt,
      stopped: this.#stopped,
      reconnect,
      pageToken,
      userEvents: {
        lastAtUtc: this.#userEventLastAtUtc,
        lastAtMonotonicMs: this.#userEventLastAtMonotonicMs,
        total: this.#userEventTotal,
      },
      consent,
    }
  }
}
