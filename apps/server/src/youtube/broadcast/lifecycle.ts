import { randomUUID } from 'node:crypto'

import type { Clock } from '../../clock.js'
import type { PersistenceStore } from '../../db/store.js'
import type {
  BroadcastAttemptRecord,
  BroadcastMutatingCall,
  BroadcastStage,
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
 * configured title, the broadcast by the `scheduledStartTime` this attempt chose
 * and persisted before calling insert.
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

/** A call whose result stayed unknown even after reconciling. */
export class BroadcastReconcileFailedError extends Error {
  readonly call: BroadcastMutatingCall

  constructor(call: BroadcastMutatingCall, attempts: number) {
    super(`${call} could not be confirmed after ${String(attempts)} attempt(s) and a reconcile`)
    this.name = 'BroadcastReconcileFailedError'
    this.call = call
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
    return this.#reconcile(open, open.pendingCall)
  }

  /** Creates or reuses the stream, creates or adopts the broadcast, binds them. */
  async ensureBound(): Promise<BroadcastBinding> {
    let attempt = (await this.resume()) ?? this.#beginAttempt()
    attempt = await this.#ensureStream(attempt)
    attempt = await this.#ensureBroadcast(attempt)
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
    const broadcastId = attempt.broadcastId
    if (broadcastId === null) {
      return this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', 'never_created')
    }
    let closeReason: string | undefined
    try {
      await this.#runCall(attempt, 'liveBroadcasts.transition', () =>
        this.#api.transitionBroadcast({ broadcastId, broadcastStatus: 'complete' }),
      )
    } catch (error) {
      const reason =
        error instanceof YouTubeApiCallError
          ? (error.reason ?? error.classification.kind)
          : 'unknown'
      if (reason !== 'redundantTransition') {
        // The attempt is closed regardless: leaving it open would make the next
        // `ensureLive` resume a broadcast this host has already walked away from.
        // The reason is recorded so an operator can see that the broadcast may
        // still be live at YouTube — the recover-first path above will find it.
        closeReason = `complete_failed:${reason}`
        this.#logger.warn('completing the broadcast failed; closing the attempt anyway', {
          attemptId: attempt.attemptId,
          reason,
        })
      }
    }
    return this.#store.closeBroadcastAttempt(attempt.attemptId, 'complete', closeReason)
  }

  // ------------------------------------------------------------------- stages

  #beginAttempt(): BroadcastAttemptRecord {
    this.#adopted = false
    return this.#store.beginBroadcastAttempt({
      attemptId: this.#newAttemptId(),
      strategy: this.#config.strategy,
      streamTitle: this.#config.stream.title,
      scheduledStartTime: this.#nextScheduledStartTime(),
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
    const existing = await this.#findStreamByTitle(attempt.streamTitle)
    if (existing !== null) {
      // The list response carried a key for every stream on the channel; only the
      // selected one reaches the vault (see `StreamKeyCustodian`).
      await this.#streamKeys.commit(existing, { required: false })
      return this.#store.recordBroadcastCallResult(attempt.attemptId, {
        stage: 'stream_ready',
        streamId: existing,
      })
    }

    return this.#withRetries(
      attempt,
      'liveStreams.insert',
      async (current) => {
        const created = await this.#runCall(current, 'liveStreams.insert', () =>
          this.#api.insertLiveStream({
            title: current.streamTitle,
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
            ...(this.#config.description === '' ? {} : { description: this.#config.description }),
            scheduledStartTime: current.scheduledStartTime,
            privacyStatus: this.#config.privacyStatus,
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
          result = await this.#runCall(current, 'liveBroadcasts.transition', () =>
            this.#api.transitionBroadcast({ broadcastId, broadcastStatus }),
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
  ): Promise<T> {
    this.#store.markBroadcastCallPending(attempt.attemptId, call)
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
      return this.#reconcile(attempt, call)
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
  ): Promise<BroadcastAttemptRecord> {
    switch (call) {
      case 'liveStreams.insert': {
        const streamId = await this.#findStreamByTitle(attempt.streamTitle)
        this.#alertReconcile(call, streamId !== null, { attemptId: attempt.attemptId })
        if (streamId === null) {
          this.#streamKeys.discard()
          return this.#store.recordBroadcastCallResult(attempt.attemptId, {
            lastErrorReason: 'reconciled_not_applied',
          })
        }
        // The insert did land: the stream exists, so its key has to reach the vault
        // even though this process never saw the insert's own response.
        await this.#streamKeys.commit(streamId, { required: true })
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          stage: 'stream_ready',
          streamId,
        })
      }
      case 'liveBroadcasts.insert': {
        const found = await this.#findBroadcastByScheduledStart(attempt.scheduledStartTime)
        this.#alertReconcile(call, found !== null, { attemptId: attempt.attemptId })
        if (found === null) {
          return this.#store.recordBroadcastCallResult(attempt.attemptId, {
            lastErrorReason: 'reconciled_not_applied',
          })
        }
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          stage: 'broadcast_created',
          broadcastId: found.id,
          ...(found.liveChatId === null ? {} : { liveChatId: found.liveChatId }),
          ...(found.enableAutoStart === null ? {} : { autoStart: found.enableAutoStart }),
        })
      }
      case 'liveBroadcasts.bind': {
        const observed = await this.#readBroadcast(requireId(attempt.broadcastId, 'broadcastId'))
        const applied = observed !== null && observed.boundStreamId === attempt.streamId
        this.#alertReconcile(call, applied, { attemptId: attempt.attemptId })
        return applied
          ? this.#store.recordBroadcastCallResult(attempt.attemptId, { stage: 'bound' })
          : this.#store.recordBroadcastCallResult(attempt.attemptId, {
              lastErrorReason: 'reconciled_not_applied',
            })
      }
      case 'liveBroadcasts.transition': {
        const observed = await this.#readBroadcast(requireId(attempt.broadcastId, 'broadcastId'))
        const status = observed?.lifeCycleStatus ?? null
        this.#alertReconcile(call, status !== null, {
          attemptId: attempt.attemptId,
          lifeCycleStatus: status,
        })
        if (observed === null) {
          return this.#store.recordBroadcastCallResult(attempt.attemptId, {
            lastErrorReason: 'reconciled_not_applied',
          })
        }
        if (isLiveLifeCycleStatus(status)) {
          return this.#markLive(attempt, observed)
        }
        if (status === 'testing' || status === 'testStarting') {
          return this.#store.recordBroadcastCallResult(attempt.attemptId, { stage: 'testing' })
        }
        return this.#store.recordBroadcastCallResult(attempt.attemptId, {
          lastErrorReason: 'reconciled_not_applied',
        })
      }
    }
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
      const reused = await this.#findStreamByTitle(attempt.streamTitle)
      if (reused === null) {
        return this.#requestSafeStop(attempt, reason, {
          limit,
          method: error.method,
          recoverable: false,
        })
      }
      await this.#streamKeys.commit(reused, { required: false })
      this.#alert('broadcast_recovered', reason, { limit, streamId: reused })
      return this.#store.recordBroadcastCallResult(attempt.attemptId, {
        stage: 'stream_ready',
        streamId: reused,
      })
    }

    const candidate = await this.#findRecoverableBroadcast(attempt)
    // A limit on `transition` blocked *going live*. Adopting a broadcast that is
    // not live would resolve nothing while reporting success, so only a live one
    // counts as recovery there.
    const recovered =
      candidate !== null &&
      (error.method !== 'liveBroadcasts.transition' ||
        isLiveLifeCycleStatus(candidate.lifeCycleStatus))
    if (!recovered || candidate === null) {
      return this.#requestSafeStop(attempt, reason, {
        limit,
        method: error.method,
        recoverable: false,
        ...(candidate === null ? {} : { candidateLifeCycleStatus: candidate.lifeCycleStatus }),
      })
    }
    this.#alert('broadcast_recovered', reason, {
      limit,
      broadcastId: candidate.id,
      lifeCycleStatus: candidate.lifeCycleStatus,
    })
    return this.#adoptBroadcast(attempt, candidate)
  }

  async #findRecoverableBroadcast(
    attempt: BroadcastAttemptRecord,
  ): Promise<LiveBroadcastSummary | null> {
    const seen: LiveBroadcastSummary[] = []
    for (const broadcastStatus of ['active', 'upcoming'] as const) {
      const page = await this.#api.listBroadcasts(
        { broadcastStatus },
        { maxPages: this.#config.reconcileMaxPages },
      )
      seen.push(...page)
    }
    const ours = seen.filter(
      (candidate) =>
        isAdoptableLifeCycleStatus(candidate.lifeCycleStatus) &&
        (candidate.id === attempt.broadcastId ||
          (attempt.streamId !== null && candidate.boundStreamId === attempt.streamId) ||
          candidate.title === this.#config.title),
    )
    // Prefer one that is already carrying video: adopting it costs no transition.
    return (
      ours.find((candidate) => isLiveLifeCycleStatus(candidate.lifeCycleStatus)) ?? ours[0] ?? null
    )
  }

  /**
   * Points an attempt at an existing broadcast. When another attempt row already
   * owns that broadcast (the unique index in migration 002), the current attempt is
   * abandoned and the owning one continues — two rows must never claim one resource.
   */
  async #adoptBroadcast(
    attempt: BroadcastAttemptRecord,
    candidate: LiveBroadcastSummary,
  ): Promise<BroadcastAttemptRecord> {
    this.#adopted = true
    // An external id is write-once per row, so adopting a *different* broadcast than
    // this attempt already owns means this attempt is finished and another row takes
    // over: one open row per resource (migration 002's unique index).
    const owner = this.#store
      .listBroadcastAttempts()
      .find((row) => row.broadcastId === candidate.id && row.closedAt === null)

    let target = attempt
    if (owner !== undefined) {
      if (owner.attemptId !== attempt.attemptId) {
        this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', 'adopted_other_attempt')
      }
      target = owner
    } else if (attempt.broadcastId !== null && attempt.broadcastId !== candidate.id) {
      this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', 'adopted_other_broadcast')
      target = this.#store.beginBroadcastAttempt({
        attemptId: this.#newAttemptId(),
        strategy: this.#config.strategy,
        streamTitle: attempt.streamTitle,
        scheduledStartTime: candidate.scheduledStartTime ?? attempt.scheduledStartTime,
      })
    }

    const stage: BroadcastStage = isLiveLifeCycleStatus(candidate.lifeCycleStatus)
      ? 'live'
      : candidate.boundStreamId !== null
        ? 'bound'
        : 'broadcast_created'
    // The ingestion stream belongs to this host, not to the broadcast, so a
    // replacement row keeps the stream the abandoned attempt had already found.
    const streamId = candidate.boundStreamId ?? attempt.streamId
    return this.#store.recordBroadcastCallResult(target.attemptId, {
      ...(stageAtLeast(target.stage, stage) ? {} : { stage }),
      broadcastId: candidate.id,
      ...(streamId === null || target.streamId !== null ? {} : { streamId }),
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

  async #findStreamByTitle(title: string): Promise<string | null> {
    const streams = await this.#api.listLiveStreams(
      { mine: true },
      { maxPages: this.#config.reconcileMaxPages },
    )
    return streams.find((stream) => stream.title === title)?.id ?? null
  }

  async #findBroadcastByScheduledStart(
    scheduledStartTime: string,
  ): Promise<LiveBroadcastSummary | null> {
    const target = Date.parse(scheduledStartTime)
    for (const broadcastStatus of ['upcoming', 'active'] as const) {
      const page = await this.#api.listBroadcasts(
        { broadcastStatus },
        { maxPages: this.#config.reconcileMaxPages },
      )
      // Compared as instants: YouTube echoes the time it stored, which may be the
      // same instant written with a different number of fractional digits.
      const found = page.find(
        (candidate) =>
          candidate.scheduledStartTime !== null &&
          Date.parse(candidate.scheduledStartTime) === target,
      )
      if (found !== undefined) {
        return found
      }
    }
    return null
  }

  async #readBroadcast(broadcastId: string): Promise<LiveBroadcastSummary | null> {
    const found = await this.#api.listBroadcasts({ ids: [broadcastId] }, { maxPages: 1 })
    return found[0] ?? null
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
