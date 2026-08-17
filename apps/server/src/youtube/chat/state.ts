import type { Clock } from '../../clock.js'
import type { ApiErrorClassification } from '../quota/classify.js'
import type { ChatKeepaliveConfig } from './config.js'
import type {
  ChatErrorObservation,
  ChatMode,
  ChatObservation,
  ChatReconnectObservation,
} from './health.js'

/**
 * The observations both source paths write and the health signals read
 * (spec §9.4(3), §11).
 *
 * It is deliberately a plain mutable record rather than an event bus: gRPC and
 * REST are two shapes of one source, and the reconnect count, the resume token
 * and the last user event have to be continuous across a fallback switch —
 * otherwise a switch would look like a fresh, healthy start.
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
  #disconnectedAtMonotonicMs: number | null = null
  #offlineAt: string | null = null

  #reconnectCount = 0
  #reconnectLastAt: string | null = null
  #reconnectGapMs: number | null = null
  #resumedWithToken: boolean | null = null
  #tokenRejected = false
  #reconnectsWithoutToken = 0
  #duplicatesSinceReconnect = 0
  #duplicateResetPending = false
  #estimatedLostMessages: number | null = 0

  #userEventLastAtUtc: string | null = null
  #userEventLastAtMonotonicMs: number | null = null
  #userEventTotal = 0
  #droppedItems = 0

  constructor(clock: Clock, keepalive: ChatKeepaliveConfig) {
    this.#clock = clock
    this.#keepalive = keepalive
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
   * A (re)connect is about to be attempted. `withToken` records whether a
   * resume token was presented, which is what decides whether a gap can be
   * bounded at all (spec §11).
   */
  connectAttempt(withToken: boolean): void {
    this.#resumedWithToken = withToken
    // The duplicate estimate belongs to the connection that actually delivers
    // something, so it is reset when the first response of the new connection
    // arrives — not here, where three failed dials in a row would erase the
    // measurement taken by the connection before them.
    this.#duplicateResetPending = true
    if (this.#reconnectCount > 0 || this.#disconnectedAtMonotonicMs !== null) {
      this.#reconnectCount += 1
      this.#reconnectLastAt = this.#clock.nowUtcIso()
      this.#reconnectGapMs =
        this.#disconnectedAtMonotonicMs === null
          ? null
          : this.#clock.monotonicMs() - this.#disconnectedAtMonotonicMs
      // A reconnect that could present the token resumes where it left off;
      // one that could not may have skipped an unknown number of messages.
      this.#estimatedLostMessages = withToken ? 0 : null
      if (!withToken) this.#reconnectsWithoutToken += 1
    }
  }

  /** The connection is live: a response arrived (possibly with zero items). */
  recordResponse(): void {
    if (this.#duplicateResetPending) {
      this.#duplicatesSinceReconnect = 0
      this.#duplicateResetPending = false
    }
    this.#connected = true
    this.#consecutiveFailures = 0
    this.#retryBudgetExhausted = false
    this.#lastResponseAtUtc = this.#clock.nowUtcIso()
    this.#lastResponseAtMonotonicMs = this.#clock.monotonicMs()
  }

  recordCommit(outcome: {
    duplicates: number
    dropped: number
    userEvents: number
    userEventAt: string | null
  }): void {
    this.#duplicatesSinceReconnect += outcome.duplicates
    this.#droppedItems += outcome.dropped
    if (outcome.userEventAt !== null) {
      this.#userEventLastAtUtc = outcome.userEventAt
      this.#userEventLastAtMonotonicMs = this.#clock.monotonicMs()
      this.#userEventTotal += outcome.userEvents
    }
  }

  recordDisconnect(): void {
    this.#connected = false
    this.#disconnectedAtMonotonicMs = this.#clock.monotonicMs()
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
    }
  }
}
