import { randomUUID } from 'node:crypto'

import type { Clock } from '../../clock.js'
import type { PersistenceStore } from '../../db/store.js'
import type {
  BroadcastAttemptRecord,
  BroadcastMutatingCall,
  BroadcastStage,
  BroadcastTransitionTarget,
} from '../../db/types.js'
import type { HealthDetailValue } from '../../health/types.js'
import { silentLogger, type Logger } from '../../secrets/redaction.js'
import type { BackoffPolicy } from '../quota/backoff.js'
import { YouTubeApiCallError, type LiveBroadcastSummary, type YouTubeLiveApi } from './api.js'
import {
  nullBroadcastAlertSink,
  nullSafeStopRequestSink,
  type BroadcastAlertKind,
  type BroadcastAlertSink,
  type SafeStopRequestSink,
} from './alerts.js'
import {
  attemptMarkerOf,
  carriesAttemptMarker,
  describeWithMarker,
  withoutAttemptMarker,
} from './attempt-marker.js'
import type { BroadcastConfig } from './config.js'
import type { StreamKeyCustodian } from './stream-key.js'
import {
  classifyBroadcastLimit,
  isAdoptableLifeCycleStatus,
  isLiveLifeCycleStatus,
  type BroadcastLimitKind,
} from './limits.js'

/**
 * Drives one broadcast from nothing to `live` and owns the two rules spec §9.1
 * fixes for that path:
 *
 * 1. **Persist before you call.** The stage and the external ids already known are
 *    written before every mutating call, and the call itself is marked pending. A
 *    process that dies mid-call leaves that uncertainty on disk.
 * 2. **Reconcile before you retry.** When a call's result is unknown (timeout,
 *    transport failure, 5xx) the next thing that happens is a `list`, never a
 *    second attempt: `liveBroadcasts.insert` has no idempotency key, so a blind
 *    retry is how a channel ends up with two broadcasts and hits its own limits.
 *
 * The reconcile keys are ours by construction: the ingestion stream is found by its
 * configured title, and the broadcast by the **attempt marker** this attempt persisted
 * before calling insert and wrote into `snippet.description`, with its
 * `scheduledStartTime` as corroboration. A scheduled time is not an identity on its
 * own (review round 2, B1), and neither answer — adopted or not applied — may be read
 * off a truncated list (review round 3, B1).
 *
 * The marker is machine metadata, so it does not outlive its purpose: the broadcast is
 * created `private`, the marker is taken back out of the description with
 * `liveBroadcasts.update` as soon as the broadcast id is durably ours, and `publish()`
 * refuses to make anything public before that has happened (BOARD A-18).
 *
 * What this class does not do: decide that the system is degraded, sleep between
 * supervision cycles, start OBS, or restart itself out of `safe_stopped`. It
 * reports (health signals, alerts, a safe-stop request) and T12 decides (§9.2).
 */

export class BroadcastSafeStopRequiredError extends Error {
  readonly reason: string

  constructor(reason: string, detail: string) {
    super(`broadcast cannot continue automatically (${reason}): ${detail}`)
    this.name = 'BroadcastSafeStopRequiredError'
    this.reason = reason
  }
}

/**
 * The bound stream is not carrying video yet (`errorStreamInactive`). Not a fault
 * of this module: the encoder has to be pushing before a broadcast can go live.
 */
export class BroadcastStreamInactiveError extends Error {
  constructor(broadcastId: string) {
    super(
      `broadcast ${broadcastId} cannot transition while its bound stream is inactive; start the encoder first`,
    )
    this.name = 'BroadcastStreamInactiveError'
  }
}

/**
 * A reconcile that could not decide. The pending call stays on the row, so nothing
 * is retried and the next `resume()` asks YouTube again (review round 1, B2: a
 * truncated list is not evidence of absence).
 */
export class BroadcastReconcileInconclusiveError extends Error {
  readonly call: BroadcastMutatingCall
  readonly detail: string

  constructor(call: BroadcastMutatingCall, detail: string) {
    super(
      `${call} could not be reconciled (${detail}); the call stays pending and must not be retried`,
    )
    this.name = 'BroadcastReconcileInconclusiveError'
    this.call = call
    this.detail = detail
  }
}

/** A call whose result stayed unknown even after reconciling. */
export class BroadcastReconcileFailedError extends Error {
  readonly call: BroadcastMutatingCall

  constructor(call: BroadcastMutatingCall, attempts: number) {
    super(`${call} could not be confirmed after ${String(attempts)} attempt(s) and a reconcile`)
    this.name = 'BroadcastReconcileFailedError'
    this.call = call
  }
}

/**
 * Refuses to expose a broadcast that still carries the attempt marker in its
 * description (BOARD A-18). The marker is an internal identity string, and viewers see
 * descriptions on search and watch surfaces.
 */
export class BroadcastMarkerNotClearedError extends Error {
  constructor(broadcastId: string) {
    super(
      `broadcast ${broadcastId} still carries its attempt marker in the description; it cannot be made public until the marker has been removed (BOARD A-18)`,
    )
    this.name = 'BroadcastMarkerNotClearedError'
  }
}

/** Everything downstream needs once the resources exist (T9 needs `liveChatId`). */
export interface BroadcastBinding {
  readonly attemptId: string
  readonly streamId: string
  readonly broadcastId: string
  readonly liveChatId: string | null
  readonly stage: BroadcastStage
  /** null until insert answered, false after `invalidAutoStart` (spec §4). */
  readonly autoStart: boolean | null
  /** True when an existing broadcast was adopted rather than created. */
  readonly adopted: boolean
}

export interface BroadcastTarget extends BroadcastBinding {
  readonly liveChatId: string
}

export interface BroadcastLifecycleOptions {
  readonly api: YouTubeLiveApi
  readonly store: PersistenceStore
  readonly config: BroadcastConfig
  readonly clock: Clock
  /**
   * Retry schedule for a step whose result was unknown. Required rather than
   * defaulted: the numbers belong to `youtube.quota.backoff` (T3), not to a literal
   * invented here.
   */
  readonly backoff: BackoffPolicy
  /**
   * Holds the stream key between the API response and the vault write. The same
   * instance must own `YouTubeLiveApi`'s `streamKeySink`, or a key would be staged
   * where nothing commits it.
   */
  readonly streamKeys: StreamKeyCustodian
  readonly alerts?: BroadcastAlertSink
  readonly safeStop?: SafeStopRequestSink
  readonly logger?: Logger
  /** Injected in tests so attempt ids are reproducible (CLAUDE.md §4). */
  readonly newAttemptId?: () => string
}

export class BroadcastLifecycle {
  readonly #api: YouTubeLiveApi
  readonly #store: PersistenceStore
  readonly #config: BroadcastConfig
  readonly #clock: Clock
  readonly #backoff: BackoffPolicy
  readonly #streamKeys: StreamKeyCustodian
  readonly #alerts: BroadcastAlertSink
  readonly #safeStop: SafeStopRequestSink
  readonly #logger: Logger
  readonly #newAttemptId: () => string

  #adopted = false

  constructor(options: BroadcastLifecycleOptions) {
    this.#api = options.api
    this.#store = options.store
    this.#config = options.config
    this.#clock = options.clock
    this.#backoff = options.backoff
    this.#streamKeys = options.streamKeys
    this.#alerts = options.alerts ?? nullBroadcastAlertSink
    this.#safeStop = options.safeStop ?? nullSafeStopRequestSink
    this.#logger = options.logger ?? silentLogger
    this.#newAttemptId = options.newAttemptId ?? (() => randomUUID())
  }

  /**
   * Picks up where the last process left off (spec §9.1, acceptance 3): the open
   * attempt is loaded and, if a mutating call was in flight, YouTube is asked what
   * actually happened before anything else is attempted.
   */
  async resume(): Promise<BroadcastAttemptRecord | null> {
    const open = this.#store.findOpenBroadcastAttempt()
    if (open === null) {
      return null
    }
    if (open.pendingCall === null) {
      return open
    }
    this.#logger.warn('resuming an attempt with a call of unknown outcome', {
      attemptId: open.attemptId,
      pendingCall: open.pendingCall,
      stage: open.stage,
    })
    return this.#reconcile(open, open.pendingCall, open.pendingTransition)
  }

  /** Creates or reuses the stream, creates or adopts the broadcast, binds them. */
  async ensureBound(): Promise<BroadcastBinding> {
    let attempt = (await this.resume()) ?? this.#beginAttempt()
    attempt = await this.#ensureStream(attempt)
    attempt = await this.#ensureBroadcast(attempt)
    // The broadcast id is durable from here on, so the marker has done its job and
    // comes back out before anything can expose the description (BOARD A-18).
    attempt = await this.#clearAttemptMarker(attempt)
    attempt = await this.#ensureBound(attempt)
    return this.#toBinding(attempt)
  }

  /**
   * Takes a bound broadcast to `live`. Auto-start is given the configured window
   * first; the transition path is the fallback, both when YouTube rejected
   * `enableAutoStart` outright (`invalidAutoStart`) and when it accepted the flag
   * but the broadcast never left `ready` (spec §4 asks for the first; the second is
   * defensive, and is reported as its own reason so the two are not confused).
   */
  async goLive(): Promise<BroadcastTarget> {
    const bound = await this.#requireOpenAttempt()
    const attempt = await this.#goLive(bound)
    const binding = this.#toBinding(attempt)
    if (binding.liveChatId === null) {
      throw new Error(
        `broadcast ${binding.broadcastId} is live but reported no liveChatId; the chat listener cannot start`,
      )
    }
    return { ...binding, liveChatId: binding.liveChatId }
  }

  async ensureLive(): Promise<BroadcastTarget> {
    await this.ensureBound()
    return this.goLive()
  }

  /**
   * Applies `youtube.broadcast.privacyStatus` to the broadcast — the only path from
   * `private` to anything visible (BOARD A-18).
   *
   * Never called from `ensureLive()`: spec §9.1 keeps 최초 공개 with the operator, so
   * this is a step T12 or an operator triggers. It refuses while the attempt marker is
   * still in the description, which is what keeps internal metadata off a viewer
   * surface (spec §4, §12.5).
   */
  async publish(): Promise<BroadcastAttemptRecord> {
    const attempt = await this.#requireOpenAttempt()
    const broadcastId = requireId(attempt.broadcastId, 'broadcastId')
    if (attempt.markerClearedAt === null) {
      throw new BroadcastMarkerNotClearedError(broadcastId)
    }
    const privacyStatus = this.#config.privacyStatus
    if (privacyStatus === 'private') {
      throw new Error(
        'youtube.broadcast.privacyStatus is "private", so there is nothing to publish; set it to public or unlisted first',
      )
    }

    return this.#withRetries(
      attempt,
      'liveBroadcasts.update',
      async (current) => {
        const updated = await this.#runCall(current, 'liveBroadcasts.update', () =>
          this.#api.updateBroadcast({
            broadcastId,
            // `privacyStatus` is the only writable member of `status` this method
            // documents, so it travels alone. `selfDeclaredMadeForKids` is set at insert
            // and is not updatable here (review round 4, M2).
            status: { privacyStatus },
          }),
        )
        if (updated.privacyStatus !== privacyStatus) {
          throw new Error(
            `broadcast ${broadcastId} reports privacyStatus ${String(updated.privacyStatus)} after asking for ${privacyStatus}`,
          )
        }
        this.#alert('broadcast_published', privacyStatus, { broadcastId })
        return this.#store.recordBroadcastCallResult(current.attemptId, { lastErrorReason: null })
      },
      // Setting the same privacy twice is harmless, so a retry is always allowed to
      // run rather than being short-circuited by a row that records nothing about it.
      () => false,
    )
  }

  /**
   * Takes the attempt marker back out of `snippet.description` (BOARD A-18) and
   * records that it is gone, so `publish()` can tell.
   *
   * The broadcast is read first: an *adopted* broadcast never carried our marker, and
   * rewriting a description this host did not write would be vandalism. Only the marker
   * is removed — the surrounding text is whatever YouTube currently holds, so an
   * operator edit made in Studio in the meantime survives.
   */
  async #clearAttemptMarker(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    if (attempt.markerClearedAt !== null || attempt.broadcastId === null) {
      return attempt
    }
    const broadcastId = attempt.broadcastId
    const observed = await this.#readBroadcast(broadcastId)
    if (observed === null) {
      throw new Error(`broadcast ${broadcastId} cannot be read back to clear its attempt marker`)
    }
    if (!carriesAttemptMarker(observed.description, attempt.attemptMarker)) {
      // Nothing of ours to remove: an adopted broadcast, or a strip that already
      // landed before this process died.
      return this.#store.updateBroadcastAttempt(attempt.attemptId, { markerCleared: true })
    }

    const scheduledStartTime = observed.scheduledStartTime ?? attempt.scheduledStartTime
    const scheduledEndTime = observed.scheduledEndTime
    const description = withoutAttemptMarker(observed.description, attempt.attemptMarker)

    return this.#withRetries(
      attempt,
      'liveBroadcasts.update',
      async (current) => {
        const updated = await this.#runCall(current, 'liveBroadcasts.update', () =>
          // What travels, and what deliberately does not (review round 4, M1):
          // `scheduledStartTime` is required with `snippet`; `scheduledEndTime` has no
          // exemption from deletion-on-omission, so an operator's end time is read back
          // and sent again; `title` is exempt since 2023-08-01, so it is left out
          // rather than overwriting a Studio edit made since this read.
          this.#api.updateBroadcast({
            broadcastId,
            snippet: {
              description,
              scheduledStartTime,
              ...(scheduledEndTime === null ? {} : { scheduledEndTime }),
            },
          }),
        )
        if (carriesAttemptMarker(updated.description, current.attemptMarker)) {
          throw new Error(
            `broadcast ${broadcastId} still carries its attempt marker after the update`,
          )
        }
        if (updated.scheduledEndTime !== scheduledEndTime) {
          throw new Error(
            `broadcast ${broadcastId} lost its scheduledEndTime (${String(scheduledEndTime)} → ${String(updated.scheduledEndTime)}) while its attempt marker was removed`,
          )
        }
        this.#alert('attempt_marker_cleared', 'updated', { broadcastId })
        // The outcome is known, so the pending marker goes with the same write.
        return this.#store.recordBroadcastCallResult(current.attemptId, { markerCleared: true })
      },
      (current) => current.markerClearedAt !== null,
    )
  }

  /**
   * Ends the current broadcast and brings a new one up (spec §9.3 rolling
   * experiment). Only the `rolling-experiment` strategy may call it: §9.3 forbids
   * implementing both strategies as production automation, so `single` refuses here
   * rather than quietly rolling over.
   */
  async rollOver(): Promise<BroadcastTarget> {
    if (this.#config.strategy !== 'rolling-experiment') {
      throw new Error(
        `rollOver() requires youtube.broadcast.strategy = "rolling-experiment" (spec §9.3); the configured strategy is "${this.#config.strategy}"`,
      )
    }
    this.#logger.warn('rolling over: experiment strategy, not production automation', {
      strategy: this.#config.strategy,
    })
    const current = this.#store.findOpenBroadcastAttempt()
    if (current !== null) {
      await this.stopBroadcast(current)
    }
    this.#adopted = false
    return this.ensureLive()
  }

  /**
   * Transitions a broadcast to `complete` and closes its attempt. A broadcast that
   * is already complete, or was never created, closes without a call.
   */
  async stopBroadcast(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    if (attempt.broadcastId === null) {
      return this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', 'never_created')
    }
    // Ending a broadcast is a mutating call like any other, so it goes through the
    // same reconcile-then-retry wrapper (review round 1, B4). Closing the attempt on
    // an *unknown* outcome was the bug: the row said `complete` while YouTube still
    // said `live`, and nothing had asked.
    return this.#withRetries(
      attempt,
      'liveBroadcasts.transition',
      async (current) => {
        const broadcastId = requireId(current.broadcastId, 'broadcastId')
        try {
          await this.#runCall(
            current,
            'liveBroadcasts.transition',
            () => this.#api.transitionBroadcast({ broadcastId, broadcastStatus: 'complete' }),
            'complete',
          )
        } catch (error) {
          // "already in the requested status" — the broadcast is over, which is the
          // outcome this call wanted.
          if (!(error instanceof YouTubeApiCallError) || error.reason !== 'redundantTransition') {
            throw error
          }
        }
        return this.#store.closeBroadcastAttempt(current.attemptId, 'complete')
      },
      (current) => current.closedAt !== null && current.stage === 'complete',
    )
  }

  // ------------------------------------------------------------------- stages

  #beginAttempt(): BroadcastAttemptRecord {
    this.#adopted = false
    const attemptId = this.#newAttemptId()
    return this.#store.beginBroadcastAttempt({
      attemptId,
      strategy: this.#config.strategy,
      streamTitle: this.#config.stream.title,
      scheduledStartTime: this.#nextScheduledStartTime(),
      attemptMarker: attemptMarkerOf(attemptId),
    })
  }

  /** `snippet.scheduledStartTime` must be in the future (`invalidScheduledStartTime`). */
  #nextScheduledStartTime(): string {
    return new Date(
      Date.parse(this.#clock.nowUtcIso()) + this.#config.scheduledStartLeadMs,
    ).toISOString()
  }

  async #ensureStream(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    if (attempt.streamId !== null) {
      return attempt
    }
    // Reuse before create: the configured title is the identity of this product's
    // ingestion stream, and a second stream would be a second stream key for the
    // operator to keep (spec §T10 "생성/재사용").
    const existing = await this.#selectStreamByTitle(attempt.streamTitle, { requireKey: false })
    if (existing.streamId !== null) {
      return this.#store.recordBroadcastCallResult(attempt.attemptId, {
        stage: 'stream_ready',
        streamId: existing.streamId,
      })
    }

    return this.#withRetries(
      attempt,
      'liveStreams.insert',
      async (current) => {
        const created = await this.#runCall(current, 'liveStreams.insert', () =>
          this.#api.insertLiveStream({
            title: current.streamTitle,
            // The identity a reconcile matches on. The title cannot serve: it is the
            // reuse key, so several streams can carry it (review round 5, B1).
            description: describeWithMarker('', current.attemptMarker),
            resolution: this.#config.stream.resolution,
            frameRate: this.#config.stream.frameRate,
            ingestionType: this.#config.stream.ingestionType,
            isReusable: this.#config.stream.isReusable,
          }),
        )
        // A stream this process just created is unusable without its key.
        await this.#streamKeys.commit(created.id, { required: true })
        return this.#store.recordBroadcastCallResult(current.attemptId, {
          stage: 'stream_ready',
          streamId: created.id,
        })
      },
      (current) => current.streamId !== null,
    )
  }

  async #ensureBroadcast(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    if (attempt.broadcastId !== null) {
      return attempt
    }
    return this.#withRetries(
      attempt,
      'liveBroadcasts.insert',
      async (current) => {
        const autoStart = this.#config.enableAutoStart && current.autoStart !== false
        const created = await this.#runCall(current, 'liveBroadcasts.insert', () =>
          this.#api.insertBroadcast({
            title: this.#config.title,
            // The marker is the only thing that will identify this call's result in a
            // `list` response (review round 2, B1), so it always travels.
            description: describeWithMarker(this.#config.description, current.attemptMarker),
            scheduledStartTime: current.scheduledStartTime,
            // Always private, whatever `config.privacyStatus` asks for: while the
            // marker is in the description nothing may be viewer-visible, and spec
            // §9.1 keeps first publication with the operator anyway. `publish()`
            // applies the configured privacy afterwards (BOARD A-18).
            privacyStatus: 'private',
            selfDeclaredMadeForKids: this.#config.selfDeclaredMadeForKids,
            latencyPreference: this.#config.latencyPreference,
            enableAutoStart: autoStart,
            enableAutoStop: this.#config.enableAutoStop,
            enableDvr: this.#config.enableDvr,
            enableMonitorStream: this.#config.enableMonitorStream,
          }),
        )
        return this.#store.recordBroadcastCallResult(current.attemptId, {
          stage: 'broadcast_created',
          broadcastId: created.id,
          ...(created.liveChatId === null ? {} : { liveChatId: created.liveChatId }),
          autoStart: created.enableAutoStart ?? autoStart,
        })
      },
      (current) => current.broadcastId !== null,
    )
  }

  async #ensureBound(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    if (stageAtLeast(attempt.stage, 'bound')) {
      return attempt
    }
    // The ids are read from `current` inside the step, never captured outside it: a
    // limit recovery can move the attempt onto a different broadcast mid-step.
    return this.#withRetries(
      attempt,
      'liveBroadcasts.bind',
      async (current) => {
        const broadcastId = requireId(current.broadcastId, 'broadcastId')
        const streamId = requireId(current.streamId, 'streamId')
        const bound = await this.#runCall(current, 'liveBroadcasts.bind', () =>
          this.#api.bindBroadcast({ broadcastId, streamId }),
        )
        if (bound.boundStreamId !== streamId) {
          throw new Error(
            `bind returned boundStreamId ${String(bound.boundStreamId)} for broadcast ${broadcastId}, expected ${streamId}`,
          )
        }
        return this.#store.recordBroadcastCallResult(current.attemptId, { stage: 'bound' })
      },
      (current) => stageAtLeast(current.stage, 'bound'),
    )
  }

  async #goLive(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    let current = attempt
    if (current.stage === 'live') {
      return current
    }
    const broadcastId = requireId(current.broadcastId, 'broadcastId')

    if (current.autoStart === true) {
      const awaited = await this.#waitForAutoStart(current, broadcastId)
      if (awaited !== null) {
        return awaited
      }
      // Auto-start was accepted but never fired. Fall through to the transition
      // path with its own reason, so this is not confused with `invalidAutoStart`.
      this.#alert('auto_start_unsupported', 'auto_start_did_not_fire', {
        broadcastId,
        waitedMs: this.#config.autoStartWaitMs,
      })
      current = this.#store.updateBroadcastAttempt(current.attemptId, {
        lastErrorReason: 'auto_start_did_not_fire',
      })
    }

    const observed = await this.#readBroadcast(broadcastId)
    if (observed !== null && isLiveLifeCycleStatus(observed.lifeCycleStatus)) {
      return this.#markLive(current, observed)
    }

    // With the monitor stream enabled a broadcast must pass through `testing`
    // before `live`; with it disabled `testing` is not a legal target.
    if (this.#config.enableMonitorStream && observed?.lifeCycleStatus !== 'testing') {
      current = await this.#transition(current, 'testing', 'testing')
      // A limit recovery inside the step may already have landed on a live one.
      if (current.stage === 'live') {
        return current
      }
    }
    return this.#transition(current, 'live', 'live')
  }

  async #transition(
    attempt: BroadcastAttemptRecord,
    broadcastStatus: 'testing' | 'live',
    stage: BroadcastStage,
  ): Promise<BroadcastAttemptRecord> {
    return this.#withRetries(
      attempt,
      'liveBroadcasts.transition',
      async (current) => {
        const broadcastId = requireId(current.broadcastId, 'broadcastId')
        let result: LiveBroadcastSummary
        try {
          result = await this.#runCall(
            current,
            'liveBroadcasts.transition',
            () => this.#api.transitionBroadcast({ broadcastId, broadcastStatus }),
            broadcastStatus,
          )
        } catch (error) {
          if (error instanceof YouTubeApiCallError && error.reason === 'redundantTransition') {
            // "The broadcast is already in the requested status" — the desired end
            // state holds, so this is a success, not a failure to retry.
            const observed = await this.#readBroadcast(broadcastId)
            return observed !== null && stage === 'live'
              ? this.#markLive(current, observed)
              : this.#store.recordBroadcastCallResult(current.attemptId, { stage })
          }
          if (error instanceof YouTubeApiCallError && error.reason === 'errorStreamInactive') {
            this.#store.recordBroadcastCallResult(current.attemptId, {
              lastErrorReason: 'errorStreamInactive',
            })
            throw new BroadcastStreamInactiveError(broadcastId)
          }
          throw error
        }
        return stage === 'live'
          ? this.#markLive(current, result)
          : this.#store.recordBroadcastCallResult(current.attemptId, { stage })
      },
      (current) =>
        stage === 'live' ? current.stage === 'live' : stageAtLeast(current.stage, 'testing'),
    )
  }

  #markLive(
    attempt: BroadcastAttemptRecord,
    observed: LiveBroadcastSummary,
  ): BroadcastAttemptRecord {
    return this.#store.recordBroadcastCallResult(attempt.attemptId, {
      stage: 'live',
      ...(observed.liveChatId === null ? {} : { liveChatId: observed.liveChatId }),
      lastErrorReason: null,
    })
  }

  /**
   * Polls until the broadcast reports itself live, or the configured window ends.
   * Returns null when auto-start did not happen in time.
   */
  async #waitForAutoStart(
    attempt: BroadcastAttemptRecord,
    broadcastId: string,
  ): Promise<BroadcastAttemptRecord | null> {
    const polls = Math.max(
      1,
      Math.ceil(this.#config.autoStartWaitMs / this.#config.statusPollIntervalMs),
    )
    for (let poll = 0; poll < polls; poll += 1) {
      const observed = await this.#readBroadcast(broadcastId)
      if (observed !== null && isLiveLifeCycleStatus(observed.lifeCycleStatus)) {
        return this.#markLive(attempt, observed)
      }
      await this.#sleep(this.#config.statusPollIntervalMs)
    }
    return null
  }

  // ------------------------------------------------------------ call plumbing

  /**
   * Marks the call pending, runs it, and turns every failure into a decision:
   * a limit is recovered from, a definitive rejection clears the pending marker
   * (nothing was applied), an unknown result stays pending until `#reconcile`
   * has asked YouTube what happened.
   */
  async #runCall<T>(
    attempt: BroadcastAttemptRecord,
    call: BroadcastMutatingCall,
    invoke: () => Promise<T>,
    transitionTarget?: BroadcastTransitionTarget,
  ): Promise<T> {
    this.#store.markBroadcastCallPending(attempt.attemptId, call, transitionTarget)
    try {
      return await invoke()
    } catch (error) {
      if (error instanceof YouTubeApiCallError && !error.needsReconcile) {
        // `not_attempted` and `rejected` both mean nothing changed at YouTube.
        this.#store.recordBroadcastCallResult(attempt.attemptId, {
          lastErrorReason: error.reason ?? error.classification.kind,
        })
      }
      throw error
    }
  }

  /**
   * One step, with the reconcile-then-retry rule applied to it. The step body is
   * expected to leave the attempt updated; this wrapper only decides whether to
   * look at YouTube and whether to try again.
   */
  async #withRetries(
    attempt: BroadcastAttemptRecord,
    call: BroadcastMutatingCall,
    step: (current: BroadcastAttemptRecord) => Promise<BroadcastAttemptRecord>,
    satisfied: (current: BroadcastAttemptRecord) => boolean,
  ): Promise<BroadcastAttemptRecord> {
    let current = attempt
    const maxTries = Math.max(1, this.#backoff.maxAttempts)
    for (let tries = 1; tries <= maxTries; tries += 1) {
      try {
        return await step(current)
      } catch (error) {
        if (!(error instanceof YouTubeApiCallError)) {
          throw error
        }
        const limit = classifyBroadcastLimit(error)
        if (limit !== null) {
          return this.#recoverFromLimit(current, limit, error)
        }
        current = await this.#handleStepFailure(current, call, error)
        if (satisfied(current)) {
          // The reconcile found the call had been applied after all.
          return current
        }
        if (tries >= maxTries) {
          if (error.needsReconcile) {
            throw new BroadcastReconcileFailedError(call, tries)
          }
          throw error
        }
        await this.#sleep(this.#backoff.nextDelayMs(tries))
      }
    }
    return current
  }

  /**
   * Turns one failed call into the state the next try starts from. Definitive
   * rejections that name a fixable request problem are corrected here; anything
   * whose outcome is unknown goes through `#reconcile` first (spec §9.1).
   */
  async #handleStepFailure(
    attempt: BroadcastAttemptRecord,
    call: BroadcastMutatingCall,
    error: YouTubeApiCallError,
  ): Promise<BroadcastAttemptRecord> {
    if (error.needsReconcile) {
      // Re-read the row: `#runCall` wrote the pending marker (and, for a transition,
      // its target) after this record was taken, and the reconcile is only readable
      // with the target the call actually asked for (review round 1, B4).
      const pending = this.#store.getBroadcastAttempt(attempt.attemptId) ?? attempt
      return this.#reconcile(pending, call, pending.pendingTransition)
    }
    switch (error.reason) {
      case 'invalidAutoStart':
        // Documented fallback (spec §4): YouTube refused `enableAutoStart`, so the
        // broadcast is created without it and driven by `transition` instead. A 400
        // definitely created nothing, so re-inserting is safe.
        this.#alert('auto_start_unsupported', 'invalidAutoStart', {
          attemptId: attempt.attemptId,
        })
        return this.#store.recordBroadcastCallResult(attempt.attemptId, { autoStart: false })
      case 'invalidScheduledStartTime':
        // The persisted start time has fallen into the past (a long outage between
        // the plan and the call). A new one is persisted before the retry, so the
        // reconcile key stays "the value we last committed".
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          scheduledStartTime: this.#nextScheduledStartTime(),
          lastErrorReason: 'invalidScheduledStartTime',
        })
      default:
        throw error
    }
  }

  /**
   * Asks YouTube whether a call of unknown outcome was applied, and records the
   * answer (spec §9.1: "결과가 timeout 등으로 불확실하면 `list/get`으로 YouTube
   * 상태를 reconcile한 뒤에만 재시도한다").
   */
  async #reconcile(
    attempt: BroadcastAttemptRecord,
    call: BroadcastMutatingCall,
    transitionTarget: BroadcastTransitionTarget | null,
  ): Promise<BroadcastAttemptRecord> {
    switch (call) {
      case 'liveStreams.insert': {
        const search = await this.#findInsertedStream(attempt)
        this.#alertReconcile(call, search.streamId !== null, {
          attemptId: attempt.attemptId,
          listComplete: search.complete,
          markerMatches: search.markerMatches,
        })
        // Exactly the broadcast rules, in the same order (review rounds 3–5): a partial
        // scan supports no verdict, two markers mean two inserts landed, and a marker
        // whose stream carries another title is not something to reason about. None of
        // these branches has written to the vault — `#findInsertedStream` commits a key
        // only on the single-match path.
        this.#assertConclusive(attempt, call, search.complete, 'stream_list_truncated')
        this.#assertConclusive(attempt, call, search.markerMatches <= 1, 'stream_marker_ambiguous')
        if (search.streamId !== null) {
          // The insert did land: the stream exists, so its key has to reach the
          // vault even though this process never saw the insert's own response.
          return this.#store.recordBroadcastCallResult(attempt.attemptId, {
            stage: 'stream_ready',
            streamId: search.streamId,
          })
        }
        this.#assertConclusive(
          attempt,
          call,
          search.markerMatches === 0,
          'stream_marker_title_mismatch',
        )
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          lastErrorReason: 'reconciled_not_applied',
        })
      }
      case 'liveBroadcasts.insert': {
        const search = await this.#findInsertedBroadcast(attempt)
        this.#alertReconcile(call, search.found !== null, {
          attemptId: attempt.attemptId,
          listComplete: search.complete,
          markerMatches: search.markerMatches,
        })
        // A partial scan cannot establish anything, in either direction. `markerMatches`
        // is only a lower bound while the list is truncated, so one visible marker does
        // not make it the only one — the copy the insert actually created can sit past
        // the page bound (review round 3, B1). No verdict is reachable from here.
        this.#assertConclusive(attempt, call, search.complete, 'broadcast_list_truncated')
        // More than one broadcast carrying this attempt's marker means two inserts
        // landed. Picking either would orphan the other, so a human decides.
        this.#assertConclusive(attempt, call, search.markerMatches <= 1, 'marker_ambiguous')
        if (search.found !== null) {
          const found = search.found
          return this.#store.recordBroadcastCallResult(attempt.attemptId, {
            stage: 'broadcast_created',
            broadcastId: found.id,
            ...(found.liveChatId === null ? {} : { liveChatId: found.liveChatId }),
            ...(found.enableAutoStart === null ? {} : { autoStart: found.enableAutoStart }),
          })
        }
        // A marker match whose scheduled time disagrees is not something to reason
        // about: this attempt's own record and YouTube's copy of it differ.
        this.#assertConclusive(attempt, call, search.markerMatches === 0, 'marker_time_mismatch')
        // Only a complete scan that found no marker at all can say "not applied"
        // (review round 1, B2 — and the same rule now gates adoption above).
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          lastErrorReason: 'reconciled_not_applied',
        })
      }
      case 'liveBroadcasts.bind': {
        // An id lookup is one page by construction, so this answer is never partial.
        const observed = await this.#readBroadcast(requireId(attempt.broadcastId, 'broadcastId'))
        const applied = observed !== null && observed.boundStreamId === attempt.streamId
        this.#alertReconcile(call, applied, { attemptId: attempt.attemptId })
        if (applied) {
          return this.#store.recordBroadcastCallResult(attempt.attemptId, { stage: 'bound' })
        }
        if (observed === null) {
          // The broadcast we hold an id for is not there. Neither "bound" nor "not
          // bound" is established, so nothing may be retried on this row.
          this.#assertConclusive(attempt, call, false, 'broadcast_not_found')
        }
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          lastErrorReason: 'reconciled_not_applied',
        })
      }
      case 'liveBroadcasts.update': {
        // Both uses of `update` are judged by the state they were meant to produce, in
        // order: the marker is gone, and then the configured privacy holds. An id
        // lookup is one page, so this answer is never partial.
        const observed = await this.#readBroadcast(requireId(attempt.broadcastId, 'broadcastId'))
        if (observed === null) {
          this.#assertConclusive(attempt, call, false, 'broadcast_not_found')
        }
        const markerGone = !carriesAttemptMarker(
          observed?.description ?? null,
          attempt.attemptMarker,
        )
        this.#alertReconcile(call, markerGone, {
          attemptId: attempt.attemptId,
          privacyStatus: observed?.privacyStatus ?? null,
        })
        if (!markerGone) {
          return this.#store.recordBroadcastCallResult(attempt.attemptId, {
            lastErrorReason: 'reconciled_not_applied:marker_present',
          })
        }
        const wanted = this.#config.privacyStatus
        const privacyApplied = wanted === 'private' || observed?.privacyStatus === wanted
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          markerCleared: true,
          ...(privacyApplied
            ? { lastErrorReason: null }
            : {
                lastErrorReason: `reconciled_not_applied:privacy_${String(observed?.privacyStatus)}`,
              }),
        })
      }
      case 'liveBroadcasts.transition': {
        const observed = await this.#readBroadcast(requireId(attempt.broadcastId, 'broadcastId'))
        const status = observed?.lifeCycleStatus ?? null
        this.#alertReconcile(call, status !== null, {
          attemptId: attempt.attemptId,
          lifeCycleStatus: status,
          target: transitionTarget,
        })
        if (observed === null) {
          this.#assertConclusive(attempt, call, false, 'broadcast_not_found')
        }
        // The observed status only answers the question the *target* asked
        // (review round 1, B4): `complete` applies a stop and refutes a go-live.
        if (transitionTarget === 'complete') {
          return status === 'complete'
            ? this.#store.closeBroadcastAttempt(attempt.attemptId, 'complete')
            : this.#store.recordBroadcastCallResult(attempt.attemptId, {
                lastErrorReason: `reconciled_not_applied:${String(status)}`,
              })
        }
        if (isLiveLifeCycleStatus(status) && observed !== null) {
          return this.#markLive(attempt, observed)
        }
        if (transitionTarget === 'testing' && (status === 'testing' || status === 'testStarting')) {
          return this.#store.recordBroadcastCallResult(attempt.attemptId, { stage: 'testing' })
        }
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          lastErrorReason: `reconciled_not_applied:${String(status)}`,
        })
      }
    }
  }

  /**
   * Refuses to turn "we could not see it" into "it did not happen". The pending call
   * is deliberately left on the row: the next `resume()` asks again, and until then
   * no retry is authorized (spec §9.1).
   */
  #assertConclusive(
    attempt: BroadcastAttemptRecord,
    call: BroadcastMutatingCall,
    conclusive: boolean,
    detail: string,
  ): void {
    if (conclusive) {
      return
    }
    this.#store.updateBroadcastAttempt(attempt.attemptId, {
      lastErrorReason: `reconcile_inconclusive:${detail}`,
    })
    this.#alert('call_reconciled', 'inconclusive', { attemptId: attempt.attemptId, call, detail })
    this.#logger.warn('reconcile inconclusive; leaving the call pending', {
      attemptId: attempt.attemptId,
      call,
      detail,
    })
    throw new BroadcastReconcileInconclusiveError(call, detail)
  }

  // ------------------------------------------------------------------- limits

  /**
   * spec §9.1: on a channel limit, recover an existing broadcast first and only ask
   * for `safe_stopped` when that is impossible.
   *
   * "Recover" means *this product's* broadcast: the attempt's own broadcast, one
   * already bound to our ingestion stream, or one carrying the configured title.
   * Taking over an unrelated broadcast on the channel and pushing our video into it
   * would not be recovery, so it is not attempted.
   */
  async #recoverFromLimit(
    attempt: BroadcastAttemptRecord,
    limit: BroadcastLimitKind,
    error: YouTubeApiCallError,
  ): Promise<BroadcastAttemptRecord> {
    const reason = error.reason ?? `limit:${limit}`
    this.#alert('broadcast_limit', reason, {
      limit,
      method: error.method,
      attemptId: attempt.attemptId,
    })
    this.#store.updateBroadcastAttempt(attempt.attemptId, { lastErrorReason: reason })

    if (error.method === 'liveStreams.insert') {
      // A limit on stream creation is recovered from by reusing this product's
      // existing ingestion stream, not by looking for a broadcast. `#ensureStream`
      // already searched once, so reaching here means there is none — but it is
      // searched again rather than assumed, because the first search may itself
      // have been the call that raced with another host.
      const reused = await this.#selectStreamByTitle(attempt.streamTitle, { requireKey: false })
      if (reused.streamId === null) {
        return this.#requestSafeStop(attempt, reason, {
          limit,
          method: error.method,
          recoverable: false,
          candidatesComplete: reused.complete,
        })
      }
      this.#alert('broadcast_recovered', reason, { limit, streamId: reused.streamId })
      return this.#store.recordBroadcastCallResult(attempt.attemptId, {
        stage: 'stream_ready',
        streamId: reused.streamId,
      })
    }

    const search = await this.#findRecoverableBroadcast(attempt)
    const candidate = search.candidate
    // A limit on `transition` blocked *going live*. Adopting a broadcast that is
    // not live would resolve nothing while reporting success, so only a live one
    // counts as recovery there.
    const usable =
      candidate !== null &&
      (error.method !== 'liveBroadcasts.transition' ||
        isLiveLifeCycleStatus(candidate.lifeCycleStatus))
    if (!usable || candidate === null) {
      return this.#requestSafeStop(attempt, reason, {
        limit,
        method: error.method,
        recoverable: false,
        // A partial candidate list is reported, not hidden: safe-stopping is the
        // conservative answer either way, but the operator should know which it was.
        candidatesComplete: search.complete,
        ...(candidate === null ? {} : { candidateLifeCycleStatus: candidate.lifeCycleStatus }),
      })
    }
    const adoption = await this.#prepareAdoption(attempt, candidate)
    if (!adoption.ok) {
      return this.#requestSafeStop(attempt, adoption.reason, {
        limit,
        method: error.method,
        broadcastId: candidate.id,
        boundStreamId: candidate.boundStreamId,
        selectedStreamId: attempt.streamId,
      })
    }
    const adopted = await this.#adoptBroadcast(attempt, candidate, adoption.streamId)
    this.#alert('broadcast_recovered', reason, {
      limit,
      broadcastId: candidate.id,
      lifeCycleStatus: candidate.lifeCycleStatus,
      streamId: adoption.streamId,
      reboundStream: adoption.streamId !== attempt.streamId,
    })
    return adopted
  }

  async #findRecoverableBroadcast(attempt: BroadcastAttemptRecord): Promise<{
    readonly candidate: LiveBroadcastSummary | null
    readonly complete: boolean
  }> {
    const seen: LiveBroadcastSummary[] = []
    let complete = true
    for (const broadcastStatus of ['active', 'upcoming'] as const) {
      const page = await this.#api.listBroadcasts(
        { broadcastStatus },
        { maxPages: this.#config.reconcileMaxPages },
      )
      seen.push(...page.items)
      complete = complete && page.complete
    }
    const ours = seen.filter(
      (candidate) =>
        isAdoptableLifeCycleStatus(candidate.lifeCycleStatus) &&
        (candidate.id === attempt.broadcastId ||
          (attempt.streamId !== null && candidate.boundStreamId === attempt.streamId) ||
          candidate.title === this.#config.title),
    )
    // Prefer one that is already carrying video: adopting it costs no transition.
    const candidate =
      ours.find((entry) => isLiveLifeCycleStatus(entry.lifeCycleStatus)) ?? ours[0] ?? null
    return { candidate, complete }
  }

  /**
   * Decides whether a candidate can be adopted *as it actually is*.
   *
   * Review round 1 (B3): adoption used to keep the attempt's own `streamId` while
   * the candidate was bound to a different ingestion stream. The returned target
   * then named stream A, YouTube was pushing from stream B, and the vault still held
   * A's key — so the encoder would have streamed to the wrong place (BOARD A-16).
   * Either the candidate's real binding *and* its key are adopted together, or the
   * candidate is refused.
   */
  async #prepareAdoption(
    attempt: BroadcastAttemptRecord,
    candidate: LiveBroadcastSummary,
  ): Promise<
    | { readonly ok: true; readonly streamId: string | null }
    | { readonly ok: false; readonly reason: string }
  > {
    const bound = candidate.boundStreamId
    if (bound === null) {
      // A live broadcast always has a bound stream; one that reports none is not
      // something to build on.
      return isLiveLifeCycleStatus(candidate.lifeCycleStatus)
        ? { ok: false, reason: 'live_candidate_without_binding' }
        : { ok: true, streamId: attempt.streamId }
    }
    if (bound === attempt.streamId) {
      return { ok: true, streamId: bound }
    }
    const adopted = await this.#adoptStreamKey(bound)
    return adopted
      ? { ok: true, streamId: bound }
      : { ok: false, reason: 'bound_stream_key_unavailable' }
  }

  /** Reads the bound stream by id and puts *its* key in the vault, or fails. */
  async #adoptStreamKey(streamId: string): Promise<boolean> {
    try {
      const page = await this.#api.listLiveStreams({ ids: [streamId] }, { maxPages: 1 })
      if (!page.items.some((stream) => stream.id === streamId)) {
        this.#streamKeys.discard()
        return false
      }
      await this.#streamKeys.commit(streamId, { required: true })
      return true
    } catch (error) {
      this.#streamKeys.discard()
      this.#logger.warn('the candidate broadcast is bound to a stream this host cannot key', {
        streamId,
        reason: error instanceof Error ? error.name : 'unknown',
      })
      return false
    }
  }

  /**
   * Points an attempt at an existing broadcast. A row owns at most one broadcast and
   * one stream (write-once ids, plus migration 003's unique index), so adopting a
   * different pairing finishes this row and starts another.
   */
  async #adoptBroadcast(
    attempt: BroadcastAttemptRecord,
    candidate: LiveBroadcastSummary,
    resolvedStreamId: string | null,
  ): Promise<BroadcastAttemptRecord> {
    const owner = this.#store
      .listBroadcastAttempts()
      .find((row) => row.broadcastId === candidate.id && row.closedAt === null)
    if (
      owner !== undefined &&
      owner.streamId !== null &&
      resolvedStreamId !== null &&
      owner.streamId !== resolvedStreamId
    ) {
      // The row that owns this broadcast disagrees with YouTube about the binding.
      // Rewriting either would be a guess.
      return this.#requestSafeStop(attempt, 'adoption_binding_conflict', {
        broadcastId: candidate.id,
        ownerStreamId: owner.streamId,
        boundStreamId: resolvedStreamId,
      })
    }

    let target = attempt
    if (owner !== undefined) {
      if (owner.attemptId !== attempt.attemptId) {
        this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', 'adopted_other_attempt')
      }
      target = owner
    } else if (
      (attempt.broadcastId !== null && attempt.broadcastId !== candidate.id) ||
      (resolvedStreamId !== null &&
        attempt.streamId !== null &&
        attempt.streamId !== resolvedStreamId)
    ) {
      this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', 'adopted_other_binding')
      const replacementId = this.#newAttemptId()
      target = this.#store.beginBroadcastAttempt({
        attemptId: replacementId,
        strategy: this.#config.strategy,
        streamTitle: attempt.streamTitle,
        scheduledStartTime: candidate.scheduledStartTime ?? attempt.scheduledStartTime,
        // A replacement row adopts an existing broadcast and never inserts one, so its
        // marker is only ever the identity of a call it did not make.
        attemptMarker: attemptMarkerOf(replacementId),
      })
    }
    this.#adopted = true

    const stage: BroadcastStage = isLiveLifeCycleStatus(candidate.lifeCycleStatus)
      ? 'live'
      : candidate.boundStreamId !== null
        ? 'bound'
        : 'broadcast_created'
    return this.#store.recordBroadcastCallResult(target.attemptId, {
      ...(stageAtLeast(target.stage, stage) ? {} : { stage }),
      broadcastId: candidate.id,
      ...(resolvedStreamId === null || target.streamId !== null
        ? {}
        : { streamId: resolvedStreamId }),
      ...(candidate.liveChatId === null || target.liveChatId !== null
        ? {}
        : { liveChatId: candidate.liveChatId }),
      ...(candidate.enableAutoStart === null ? {} : { autoStart: candidate.enableAutoStart }),
    })
  }

  #requestSafeStop(
    attempt: BroadcastAttemptRecord,
    reason: string,
    detail: Readonly<Record<string, HealthDetailValue>>,
  ): never {
    const at = this.#clock.nowUtcIso()
    this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', reason)
    this.#alert('safe_stop_requested', reason, detail)
    this.#safeStop({ at, reason, detail })
    throw new BroadcastSafeStopRequiredError(
      reason,
      'no existing broadcast of this product could be recovered',
    )
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Picks an ingestion stream to *reuse* and finishes stream-key custody in the same
   * step. This is a choice among interchangeable resources, not a verdict about an
   * uncertain call — the reconcile path uses `#findInsertedStream` instead, which
   * demands the attempt marker. `liveStreams.list` returns a key for **every** stream on the channel,
   * so leaving the staged values behind would keep keys in memory outside the vault
   * (review round 1, M1): the selected one is committed, the rest are discarded, on
   * every path out of here.
   */
  async #selectStreamByTitle(
    title: string,
    options: { readonly requireKey: boolean },
  ): Promise<{ readonly streamId: string | null; readonly complete: boolean }> {
    let page
    try {
      page = await this.#api.listLiveStreams(
        { mine: true },
        { maxPages: this.#config.reconcileMaxPages },
      )
    } catch (error) {
      this.#streamKeys.discard()
      throw error
    }
    const streamId = page.items.find((stream) => stream.title === title)?.id ?? null
    if (streamId === null) {
      this.#streamKeys.discard()
    } else {
      await this.#streamKeys.commit(streamId, { required: options.requireKey })
    }
    return { streamId, complete: page.complete }
  }

  /**
   * Looks for the stream *this attempt's* insert created (review round 5, B1).
   *
   * The attempt marker in `snippet.description` is the identity; the configured title
   * only corroborates it. Matching on the title alone adopted whichever same-title
   * stream happened to be listed first — and wrote its key to the vault, which is the
   * value OBS treats as authoritative — while the stream the insert had actually
   * created was orphaned. A key is committed on exactly one path: a single marker match
   * whose title agrees, from a complete scan.
   */
  async #findInsertedStream(attempt: BroadcastAttemptRecord): Promise<{
    readonly streamId: string | null
    readonly complete: boolean
    readonly markerMatches: number
  }> {
    let page
    try {
      page = await this.#api.listLiveStreams(
        { mine: true },
        { maxPages: this.#config.reconcileMaxPages },
      )
    } catch (error) {
      this.#streamKeys.discard()
      throw error
    }
    // Nothing below writes to the vault until a single unambiguous match is in hand, so
    // an inconclusive scan leaves no trace anywhere (review round 4, B1).
    if (!page.complete) {
      this.#streamKeys.discard()
      return { streamId: null, complete: false, markerMatches: 0 }
    }
    const marked = page.items.filter((stream) =>
      carriesAttemptMarker(stream.description, attempt.attemptMarker),
    )
    const only = marked.length === 1 ? marked[0] : undefined
    if (only === undefined || only.title !== attempt.streamTitle) {
      this.#streamKeys.discard()
      return { streamId: null, complete: true, markerMatches: marked.length }
    }
    await this.#streamKeys.commit(only.id, { required: true })
    return { streamId: only.id, complete: true, markerMatches: 1 }
  }

  /**
   * Looks for the broadcast *this attempt's* insert created (review round 2, B1).
   *
   * The attempt marker is the identity; `scheduledStartTime` only corroborates it.
   * Matching on the time alone adopted whatever unrelated broadcast happened to be
   * scheduled for the same instant and left the real resource orphaned, which is not
   * a reconcile (spec §9.1). Both statuses are always scanned so `markerMatches`
   * counts every copy, not just the first.
   */
  async #findInsertedBroadcast(attempt: BroadcastAttemptRecord): Promise<{
    readonly found: LiveBroadcastSummary | null
    readonly complete: boolean
    readonly markerMatches: number
  }> {
    const target = Date.parse(attempt.scheduledStartTime)
    let complete = true
    const marked: LiveBroadcastSummary[] = []
    for (const broadcastStatus of ['upcoming', 'active'] as const) {
      const page = await this.#api.listBroadcasts(
        { broadcastStatus },
        { maxPages: this.#config.reconcileMaxPages },
      )
      complete = complete && page.complete
      for (const candidate of page.items) {
        if (carriesAttemptMarker(candidate.description, attempt.attemptMarker)) {
          marked.push(candidate)
        }
      }
    }
    // Compared as instants: YouTube echoes the time it stored, which may be the same
    // instant written with a different number of fractional digits.
    const found =
      marked.length === 1 &&
      marked[0]?.scheduledStartTime != null &&
      Date.parse(marked[0].scheduledStartTime) === target
        ? (marked[0] ?? null)
        : null
    return { found, complete, markerMatches: marked.length }
  }

  async #readBroadcast(broadcastId: string): Promise<LiveBroadcastSummary | null> {
    const page = await this.#api.listBroadcasts({ ids: [broadcastId] }, { maxPages: 1 })
    return page.items[0] ?? null
  }

  async #requireOpenAttempt(): Promise<BroadcastAttemptRecord> {
    const attempt = await this.resume()
    if (attempt === null) {
      throw new Error('no open broadcast attempt; call ensureBound() first')
    }
    return attempt
  }

  #toBinding(attempt: BroadcastAttemptRecord): BroadcastBinding {
    return {
      attemptId: attempt.attemptId,
      streamId: requireId(attempt.streamId, 'streamId'),
      broadcastId: requireId(attempt.broadcastId, 'broadcastId'),
      liveChatId: attempt.liveChatId,
      stage: attempt.stage,
      autoStart: attempt.autoStart,
      adopted: this.#adopted,
    }
  }

  #alert(
    kind: BroadcastAlertKind,
    reason: string,
    detail: Readonly<Record<string, HealthDetailValue>>,
  ): void {
    this.#alerts({ kind, at: this.#clock.nowUtcIso(), reason, detail })
  }

  #alertReconcile(
    call: BroadcastMutatingCall,
    applied: boolean,
    detail: Readonly<Record<string, HealthDetailValue>>,
  ): void {
    this.#alert('call_reconciled', applied ? 'applied' : 'not_applied', { ...detail, call })
  }

  async #sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return
    }
    await new Promise<void>((resolve) => {
      this.#clock.setTimeout(() => {
        resolve()
      }, delayMs)
    })
  }
}

const STAGE_RANK: Readonly<Record<BroadcastStage, number>> = {
  planned: 0,
  stream_ready: 1,
  broadcast_created: 2,
  bound: 3,
  testing: 4,
  live: 5,
  complete: 6,
  abandoned: -1,
}

function stageAtLeast(current: BroadcastStage, target: BroadcastStage): boolean {
  return STAGE_RANK[current] >= STAGE_RANK[target] && STAGE_RANK[current] >= 0
}

function requireId(value: string | null, label: string): string {
  if (value === null) {
    throw new Error(`broadcast attempt has no ${label} yet`)
  }
  return value
}
