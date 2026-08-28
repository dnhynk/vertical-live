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
  /** The attempt this process owns; see `#stillResumable` (T30). */
  #pickedUpAttemptId: string | null = null
  /**
   * Tail of the lifecycle-local mutation queue (T52). `pending_call` is a crash
   * reconcile marker, not an in-process mutex: without this boundary two callers
   * can both act on the same pre-call row and receive different external ids.
   */
  #mutationTail: Promise<void> = Promise.resolve()
  /** Candidate whose older open rows have already been reconciled this process. */
  #recoveryReviewedAttemptId: string | null = null
  /** Older live row that an interrupted rollover must complete before go-live. */
  #recoveryPredecessorAttemptId: string | null = null
  /** Replacement that must regain configured visibility before it goes live. */
  #recoveryReplacementAttemptId: string | null = null

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
    return this.#serializeMutation(() => this.#resume())
  }

  async #resume(): Promise<BroadcastAttemptRecord | null> {
    // A terminal newest row must reveal the next older row before a new attempt
    // is created. Otherwise every restart can leave a legitimate live predecessor
    // ignored and create another resource (the production T52 topology).
    while (true) {
      const open = this.#store.findOpenBroadcastAttempt()
      if (open === null) {
        this.#recoveryReviewedAttemptId = null
        this.#recoveryPredecessorAttemptId = null
        this.#recoveryReplacementAttemptId = null
        return null
      }
      this.#assertDurableRecoveryTopology(open)
      let candidate = open
      if (candidate.pendingCall !== null) {
        this.#logger.warn('resuming an attempt with a call of unknown outcome', {
          attemptId: candidate.attemptId,
          pendingCall: candidate.pendingCall,
          stage: candidate.stage,
        })
        candidate = await this.#reconcile(
          candidate,
          candidate.pendingCall,
          candidate.pendingTransition,
        )
      }
      const resumable = await this.#stillResumable(candidate)
      if (resumable === null) continue
      await this.#reviewOlderOpenAttempts(resumable)
      return resumable
    }
  }

  /**
   * An open row is a *claim* that this host can pick the broadcast up again;
   * YouTube is what makes it true (T30).
   *
   * Nothing in this process closes an attempt on its way out — a safe stop kills
   * the run, and the row stays open with `stage = live`. YouTube meanwhile moves
   * the abandoned broadcast to `complete`, and a complete broadcast has no live
   * chat: `streamList` answers `FAILED_PRECONDITION` at once, the chat source
   * stops, `chat_transport` degrades without even reaching its grace window, and
   * the run safe-stops on the restart budget. Measured on the host on
   * 2026-08-23: every start after the first broadcast died this way, twenty
   * seconds in, which is unattended operation not working at all.
   *
   * So a resumable stage is asked about before it is trusted. A broadcast that
   * is over — or that no longer exists — closes its attempt as `abandoned` with
   * the reason, and `ensureBound()` starts a fresh one. An answer that does not
   * settle the question decides nothing and is raised (spec §9.1: "결론이 나지
   * 않으면 재시도하지 않는다"); the start-up sequence retries it with backoff.
   */
  async #stillResumable(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord | null> {
    if (attempt.closedAt !== null) return null
    if (attempt.broadcastId === null) {
      this.#pickedUpAttemptId = attempt.attemptId
      return attempt
    }
    // Asked once, when this process takes the attempt over. `resume()` also runs
    // on the way into `goLive()`, and an attempt this process began or has
    // already checked needs no second `liveBroadcasts.list` — that would spend a
    // quota unit per call to re-read what this process itself did.
    if (attempt.attemptId === this.#pickedUpAttemptId) return attempt

    const broadcastId = attempt.broadcastId
    const found = await this.#api.listBroadcasts({ ids: [broadcastId] })
    const summary = found.items.find((item) => item.id === broadcastId) ?? null

    if (summary === null) {
      // An id lookup that comes back empty is conclusive in a way a marker search
      // is not: this exact resource is gone, so there is nothing to resume.
      return this.#discard(attempt, 'broadcast_missing', { broadcastId, lifeCycleStatus: null })
    }
    const lifeCycleStatus = summary.lifeCycleStatus
    if (lifeCycleStatus === null) {
      throw new Error(
        `liveBroadcasts.list returned broadcast ${broadcastId} without a lifeCycleStatus; cannot decide whether the attempt is resumable`,
      )
    }
    if (RESUMABLE_LIFE_CYCLE_STATUSES.includes(lifeCycleStatus)) {
      this.#pickedUpAttemptId = attempt.attemptId
      return attempt
    }
    return this.#discard(attempt, `broadcast_${lifeCycleStatus}`, { broadcastId, lifeCycleStatus })
  }

  #discard(
    attempt: BroadcastAttemptRecord,
    reason: string,
    detail: Readonly<Record<string, HealthDetailValue>>,
  ): null {
    this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', reason)
    this.#logger.warn('the open broadcast attempt cannot be resumed; starting a new one', {
      attemptId: attempt.attemptId,
      stage: attempt.stage,
      reason,
    })
    this.#alert('attempt_discarded', reason, { ...detail, attemptId: attempt.attemptId })
    return null
  }

  /**
   * Reconciles the rows hidden behind the newest open attempt after a crash.
   * Two open rows are normal for exactly one interval: a replacement is bound
   * before its live predecessor is completed. More rows are historical evidence,
   * not permission to rewrite ids or create another resource.
   */
  async #reviewOlderOpenAttempts(candidate: BroadcastAttemptRecord): Promise<void> {
    if (this.#recoveryReviewedAttemptId === candidate.attemptId) return

    this.#recoveryPredecessorAttemptId = null
    this.#recoveryReplacementAttemptId = null
    const predecessorId = candidate.rolloverPredecessorAttemptId
    if (predecessorId === null || stageAtLeast(candidate.stage, 'live')) {
      this.#recoveryReviewedAttemptId = candidate.attemptId
      return
    }

    this.#recoveryReplacementAttemptId = candidate.attemptId
    let predecessor = this.#store.getBroadcastAttempt(predecessorId)
    if (predecessor === null) {
      return this.#raiseSafeStop('rollover_predecessor_missing', {
        candidateAttemptId: candidate.attemptId,
        predecessorAttemptId: predecessorId,
      })
    }
    if (predecessor.closedAt !== null) {
      this.#recoveryReviewedAttemptId = candidate.attemptId
      return
    }
    if (predecessor.pendingCall !== null) {
      this.#logger.warn('reconciling the linked rollover predecessor', {
        attemptId: predecessor.attemptId,
        pendingCall: predecessor.pendingCall,
        candidateAttemptId: candidate.attemptId,
      })
      predecessor = await this.#reconcile(
        predecessor,
        predecessor.pendingCall,
        predecessor.pendingTransition,
      )
      if (predecessor.closedAt !== null) {
        this.#store.closeBroadcastAttempt(
          predecessor.attemptId,
          'complete',
          'rollover_predecessor_complete',
        )
        this.#recoveryReviewedAttemptId = candidate.attemptId
        return
      }
    }

    const broadcastId = requireId(predecessor.broadcastId, 'broadcastId')
    const page = await this.#api.listBroadcasts({ ids: [broadcastId] }, { maxPages: 1 })
    if (!page.complete) {
      return this.#raiseSafeStop('open_attempt_reconcile_incomplete', {
        attemptId: predecessor.attemptId,
        broadcastId,
        candidateAttemptId: candidate.attemptId,
      })
    }
    const observed = page.items.find((item) => item.id === broadcastId) ?? null
    if (observed === null) {
      this.#store.closeBroadcastAttempt(
        predecessor.attemptId,
        'abandoned',
        'rollover_predecessor_broadcast_missing',
      )
      this.#recoveryReviewedAttemptId = candidate.attemptId
      return
    }
    const status = observed.lifeCycleStatus
    if (status === 'complete') {
      this.#store.closeBroadcastAttempt(
        predecessor.attemptId,
        'complete',
        'rollover_predecessor_observed_complete',
      )
      this.#recoveryReviewedAttemptId = candidate.attemptId
      return
    }
    if (status === 'revoked') {
      this.#store.closeBroadcastAttempt(
        predecessor.attemptId,
        'abandoned',
        'rollover_predecessor_broadcast_revoked',
      )
      this.#recoveryReviewedAttemptId = candidate.attemptId
      return
    }
    if (!isLiveLifeCycleStatus(status)) {
      return this.#raiseSafeStop(
        status === null ? 'open_attempt_lifecycle_unknown' : 'open_attempt_lifecycle_ambiguous',
        {
          attemptId: predecessor.attemptId,
          broadcastId,
          lifeCycleStatus: status,
          candidateAttemptId: candidate.attemptId,
        },
      )
    }
    this.#recoveryPredecessorAttemptId = predecessor.attemptId
    this.#logger.warn('resuming an interrupted rollover before predecessor completion', {
      candidateAttemptId: candidate.attemptId,
      predecessorAttemptId: predecessor.attemptId,
    })
    this.#recoveryReviewedAttemptId = candidate.attemptId
  }

  /** Rejects ambiguous DB topology before any recovery read or mutation leaves the process. */
  #assertDurableRecoveryTopology(candidate: BroadcastAttemptRecord): void {
    const olderOpen = this.#store
      .listOpenBroadcastAttempts()
      .filter((attempt) => attempt.attemptId !== candidate.attemptId)
    const predecessorId = candidate.rolloverPredecessorAttemptId
    if (predecessorId === null) {
      if (olderOpen.length > 0) {
        const live = olderOpen.filter((attempt) => attempt.stage === 'live')
        this.#raiseSafeStop(
          live.length > 1 ? 'multiple_open_live_broadcasts' : 'rollover_provenance_missing',
          {
            candidateAttemptId: candidate.attemptId,
            olderAttemptIds: olderOpen.map((attempt) => attempt.attemptId).join(','),
          },
        )
      }
      return
    }

    const predecessor = this.#store.getBroadcastAttempt(predecessorId)
    if (predecessor === null) {
      this.#raiseSafeStop('rollover_predecessor_missing', {
        candidateAttemptId: candidate.attemptId,
        predecessorAttemptId: predecessorId,
      })
    }
    const competing = olderOpen.filter((attempt) => attempt.attemptId !== predecessorId)
    if (competing.length > 0) {
      const liveCount = olderOpen.filter((attempt) => attempt.stage === 'live').length
      this.#raiseSafeStop(
        liveCount > 1 ? 'multiple_open_live_broadcasts' : 'multiple_rollover_candidates',
        {
          candidateAttemptId: candidate.attemptId,
          predecessorAttemptId: predecessorId,
          competingAttemptIds: competing.map((attempt) => attempt.attemptId).join(','),
        },
      )
    }
    if (predecessor.streamId === null) {
      this.#raiseSafeStop('rollover_predecessor_binding_missing', {
        candidateAttemptId: candidate.attemptId,
        predecessorAttemptId: predecessorId,
      })
    }
    if (candidate.streamId !== null && candidate.streamId !== predecessor.streamId) {
      this.#raiseSafeStop('rollover_stream_mismatch', {
        candidateAttemptId: candidate.attemptId,
        candidateStreamId: candidate.streamId,
        predecessorAttemptId: predecessorId,
        predecessorStreamId: predecessor.streamId,
      })
    }
    if (predecessor.closedAt === null && predecessor.stage !== 'live') {
      this.#raiseSafeStop('rollover_predecessor_not_live', {
        candidateAttemptId: candidate.attemptId,
        predecessorAttemptId: predecessorId,
        predecessorStage: predecessor.stage,
      })
    }
    if (predecessor.closedAt === null && candidate.stage === 'live') {
      this.#raiseSafeStop('competing_live_broadcast_attempts', {
        candidateAttemptId: candidate.attemptId,
        candidateBroadcastId: candidate.broadcastId,
        predecessorAttemptId: predecessorId,
        predecessorBroadcastId: predecessor.broadcastId,
      })
    }
  }

  /** Completes the one evidence-backed live predecessor before a replacement goes live. */
  async #completeRecoveryPredecessor(candidate: BroadcastAttemptRecord): Promise<void> {
    const predecessorId = this.#recoveryPredecessorAttemptId
    if (predecessorId === null || predecessorId === candidate.attemptId) return
    if (candidate.rolloverPredecessorAttemptId !== predecessorId) {
      return this.#raiseSafeStop('rollover_predecessor_link_mismatch', {
        candidateAttemptId: candidate.attemptId,
        linkedPredecessorAttemptId: candidate.rolloverPredecessorAttemptId,
        recoveryPredecessorAttemptId: predecessorId,
      })
    }
    const predecessor = this.#store.getBroadcastAttempt(predecessorId)
    if (predecessor === null) {
      return this.#raiseSafeStop('rollover_predecessor_missing', {
        candidateAttemptId: candidate.attemptId,
        predecessorAttemptId: predecessorId,
      })
    }
    if (predecessor.closedAt !== null) {
      this.#recoveryPredecessorAttemptId = null
      return
    }
    this.#assertRolloverStreamMatches(candidate)
    await this.#stopBroadcast(predecessor, 'rollover_predecessor_complete')
    this.#recoveryPredecessorAttemptId = null
  }

  #assertRolloverStreamMatches(candidate: BroadcastAttemptRecord): void {
    const predecessorId = candidate.rolloverPredecessorAttemptId
    if (predecessorId === null) return
    const predecessor = this.#store.getBroadcastAttempt(predecessorId)
    if (predecessor === null || predecessor.streamId === null || candidate.streamId === null) {
      this.#raiseSafeStop('rollover_predecessor_binding_missing', {
        candidateAttemptId: candidate.attemptId,
        candidateStreamId: candidate.streamId,
        predecessorAttemptId: predecessorId,
        predecessorStreamId: predecessor?.streamId ?? null,
      })
    }
    if (candidate.streamId !== predecessor.streamId) {
      this.#raiseSafeStop('rollover_stream_mismatch', {
        candidateAttemptId: candidate.attemptId,
        candidateStreamId: candidate.streamId,
        predecessorAttemptId: predecessorId,
        predecessorStreamId: predecessor.streamId,
      })
    }
  }

  /** Uses the exact predecessor's reusable ingestion stream; rollover never selects another. */
  #ensureLinkedRolloverStream(candidate: BroadcastAttemptRecord): BroadcastAttemptRecord {
    if (candidate.streamId !== null) return candidate
    const predecessorId = candidate.rolloverPredecessorAttemptId
    if (predecessorId === null) return candidate
    const predecessor = this.#store.getBroadcastAttempt(predecessorId)
    if (predecessor === null || predecessor.streamId === null) {
      return this.#raiseSafeStop('rollover_predecessor_binding_missing', {
        candidateAttemptId: candidate.attemptId,
        predecessorAttemptId: predecessorId,
        predecessorStreamId: predecessor?.streamId ?? null,
      })
    }
    return this.#store.recordBroadcastCallResult(candidate.attemptId, {
      stage: 'stream_ready',
      streamId: predecessor.streamId,
    })
  }

  /** Creates or reuses the stream, creates or adopts the broadcast, binds them. */
  async ensureBound(): Promise<BroadcastBinding> {
    return this.#serializeMutation(() => this.#ensureBoundLifecycle())
  }

  async #ensureBoundLifecycle(): Promise<BroadcastBinding> {
    let attempt = (await this.#resume()) ?? this.#beginAttempt()
    attempt =
      attempt.rolloverPredecessorAttemptId === null
        ? await this.#ensureStream(attempt)
        : this.#ensureLinkedRolloverStream(attempt)
    this.#assertRolloverStreamMatches(attempt)
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
    return this.#serializeMutation(() => this.#goLiveLifecycle())
  }

  async #goLiveLifecycle(): Promise<BroadcastTarget> {
    let bound = await this.#requireOpenAttempt()
    await this.#completeRecoveryPredecessor(bound)
    if (this.#recoveryReplacementAttemptId === bound.attemptId) {
      bound = await this.#applyConfiguredPrivacy(bound)
      this.#recoveryReplacementAttemptId = null
    }
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
    return this.#serializeMutation(async () => {
      await this.#ensureBoundLifecycle()
      return this.#goLiveLifecycle()
    })
  }

  /**
   * Replaces the running broadcast when its segment is over (BOARD `D-21`,
   * spec §9.3). Returns the new binding, or `null` when nothing was due.
   *
   * **The order below is fixed by the API, not by preference.** Both quotes are
   * from the reference, checked 2026-08-23:
   *
   * - `liveBroadcasts.bind`: "A broadcast can only be bound to one video stream,
   *   though *a video stream may be bound to more than one broadcast*." So the
   *   new broadcast binds the **same ingestion stream** the encoder is already
   *   pushing to, and OBS never stops.
   * - `liveBroadcasts.transition`: `concurrentBroadcastsExceedLimit` — "One or
   *   more broadcasts that are already live must be stopped before another
   *   broadcast can start on the channel." So the old one is completed **before**
   *   the new one goes live. A design that overlaps them fails with a 403.
   *
   * Which leaves a window, between the stop and the go-live, with no live
   * broadcast on the channel. It cannot be removed, only kept short. The encoder
   * runs through it, so the stream is still `active` when the transition asks.
   * Viewers on the old URL are dropped — vertical feed has no Live Redirect
   * (spec §9.3), and that is the price D-21 accepted for having archives.
   *
   * The world is untouched: §9.3 separates world state from broadcast id, and
   * nothing here reads or writes a snapshot, an inbox row or a checkpoint.
   */
  async rolloverIfDue(): Promise<BroadcastBinding | null> {
    return this.#serializeMutation(() => this.#rolloverIfDue())
  }

  async #rolloverIfDue(): Promise<BroadcastBinding | null> {
    const segmentMs = this.#config.segmentMs
    if (segmentMs === null) return null

    const current = await this.#resume()
    if (current === null) return null

    // A swap that stopped between the two halves — the old broadcast ended and
    // the replacement never went live — leaves the channel with nothing live and
    // the open attempt at `bound`. Finish it rather than wait: measured on the
    // host, that state does not recover on its own, because the rollover check
    // below only fires for an attempt that is already `live`.
    if (current.stage === 'bound') {
      this.#logger.warn('finishing a segment swap that did not reach live', {
        attemptId: current.attemptId,
      })
      await this.#completeRecoveryPredecessor(current)
      const prepared =
        this.#recoveryReplacementAttemptId === current.attemptId
          ? await this.#applyConfiguredPrivacy(current)
          : current
      this.#recoveryReplacementAttemptId = null
      return this.#toBinding(await this.#goLive(prepared))
    }

    // Only a segment that actually reached `live` has run; anything earlier is
    // still starting up and replacing it would just restart the start-up.
    if (current.stage !== 'live') return null

    const startedAtMs = Date.parse(current.createdAt)
    if (Number.isNaN(startedAtMs)) return null
    const ageMs = Date.parse(this.#clock.nowUtcIso()) - startedAtMs
    if (ageMs < segmentMs) return null

    this.#logger.info('broadcast segment is over; rolling over', {
      attemptId: current.attemptId,
      ageMs,
      segmentMs,
    })

    // 1. A new broadcast on the stream the encoder is already feeding.
    //
    // Auto-start is switched off for it, whatever the configuration says.
    // `enableAutoStart` fires "when you start streaming video on the bound live
    // stream" (`liveBroadcasts` reference, checked 2026-08-23) — an *event*, and
    // a rollover never produces it: the encoder has been streaming all along and
    // is deliberately never stopped. Measured on the host on 2026-08-23: the
    // replacement waited out `autoStartWaitMs`, auto-start never fired, and the
    // fallback transition came back `invalidTransition` HTTP 403, leaving the
    // old broadcast complete and the new one stuck at `bound`. Off, it goes live
    // by explicit transition — and the stream is already `active`, which is the
    // precondition that transition actually needs.
    return this.#performRollover(current, 'segment_elapsed', { ageMs })
  }

  /** One fixed rollover sequence shared by due and explicit requests. */
  async #performRollover(
    current: BroadcastAttemptRecord,
    reason = 'explicit_request',
    detail: Readonly<Record<string, HealthDetailValue>> = {},
  ): Promise<BroadcastTarget> {
    // Provenance is durable in the candidate's first local write, before any
    // resource call and, critically, before the predecessor can be completed.
    let next = this.#beginAttempt(current.attemptId)
    next = this.#store.updateBroadcastAttempt(next.attemptId, { autoStart: false })
    next = this.#ensureLinkedRolloverStream(next)
    this.#assertRolloverStreamMatches(next)
    next = await this.#ensureBroadcast(next)
    next = await this.#clearAttemptMarker(next)
    next = await this.#ensureBound(next)

    await this.#stopBroadcast(current, 'rollover_predecessor_complete')
    next = await this.#applyConfiguredPrivacy(next)
    next = await this.#goLive(next)

    const binding = this.#toBinding(next)
    if (binding.liveChatId === null) {
      throw new Error(
        `broadcast ${binding.broadcastId} is live but reported no liveChatId; the chat listener cannot start`,
      )
    }
    this.#alert('broadcast_rolled_over', reason, {
      previousBroadcastId: current.broadcastId,
      broadcastId: next.broadcastId,
      ...detail,
    })
    return { ...binding, liveChatId: binding.liveChatId }
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
    return this.#serializeMutation(() => this.#publish())
  }

  async #publish(): Promise<BroadcastAttemptRecord> {
    const attempt = await this.#requireOpenAttempt()
    if (this.#config.privacyStatus === 'private') {
      throw new Error(
        'youtube.broadcast.privacyStatus is "private", so there is nothing to publish; set it to public or unlisted first',
      )
    }
    return this.#publishAttempt(attempt)
  }

  /** Applies configured non-private visibility to one marker-cleared attempt. */
  async #publishAttempt(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    const broadcastId = requireId(attempt.broadcastId, 'broadcastId')
    if (attempt.markerClearedAt === null) {
      throw new BroadcastMarkerNotClearedError(broadcastId)
    }
    const privacyStatus = this.#config.privacyStatus
    if (attempt.privacyStatus === privacyStatus) {
      return attempt
    }

    // A crash can land after YouTube applied the update but before the durable
    // result write. Exact-id read-back makes that boundary idempotent even for a
    // legacy/test row without a pending marker or visibility evidence.
    const observed = await this.#readBroadcast(broadcastId)
    if (observed?.privacyStatus === privacyStatus) {
      return this.#store.updateBroadcastAttempt(attempt.attemptId, { privacyStatus })
    }

    const published = await this.#withRetries(
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
        return this.#store.recordBroadcastCallResult(current.attemptId, {
          privacyStatus,
          lastErrorReason: null,
        })
      },
      // Reconcile records both marker removal and configured privacy. Do not send
      // a duplicate update when the first response was lost after application.
      (current) => current.pendingCall === null && current.lastErrorReason === null,
    )
    this.#alert('broadcast_published', privacyStatus, { broadcastId })
    return published
  }

  async #applyConfiguredPrivacy(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    return this.#config.privacyStatus === 'private' ? attempt : this.#publishAttempt(attempt)
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
   * Ends the current broadcast and brings a new one up (spec §9.3 selected rolling
   * production path). Only the retained `rolling-experiment` enum value may call it:
   * §9.3 forbids implementing both strategies as production automation, so `single`
   * refuses here rather than quietly rolling over.
   */
  async rollOver(): Promise<BroadcastTarget> {
    return this.#serializeMutation(() => this.#rollOver())
  }

  async #rollOver(): Promise<BroadcastTarget> {
    if (this.#config.strategy !== 'rolling-experiment') {
      throw new Error(
        `rollOver() requires youtube.broadcast.strategy = "rolling-experiment" (spec §9.3); the configured strategy is "${this.#config.strategy}"`,
      )
    }
    this.#logger.warn('rolling over: selected production rolling strategy', {
      strategy: this.#config.strategy,
    })
    const current = await this.#resume()
    if (current === null || current.stage !== 'live') {
      throw new Error('rollOver() requires one open live predecessor')
    }
    return this.#performRollover(current)
  }

  /**
   * Transitions a broadcast to `complete` and closes its attempt. A broadcast that
   * is already complete, or was never created, closes without a call.
   */
  async stopBroadcast(attempt: BroadcastAttemptRecord): Promise<BroadcastAttemptRecord> {
    return this.#serializeMutation(() => {
      // The caller may have queued behind a rollover that already closed this
      // row. Re-read after acquiring ownership instead of acting on its stale
      // pre-lock snapshot.
      const current = this.#store.getBroadcastAttempt(attempt.attemptId)
      if (current === null) {
        throw new Error(`unknown broadcast attempt ${attempt.attemptId}`)
      }
      return current.closedAt === null ? this.#stopBroadcast(current) : Promise.resolve(current)
    })
  }

  async #stopBroadcast(
    attempt: BroadcastAttemptRecord,
    completionReason?: string,
  ): Promise<BroadcastAttemptRecord> {
    if (attempt.broadcastId === null) {
      return this.#store.closeBroadcastAttempt(attempt.attemptId, 'abandoned', 'never_created')
    }
    // Ending a broadcast is a mutating call like any other, so it goes through the
    // same reconcile-then-retry wrapper (review round 1, B4). Closing the attempt on
    // an *unknown* outcome was the bug: the row said `complete` while YouTube still
    // said `live`, and nothing had asked.
    const stopped = await this.#withRetries(
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
        return this.#store.closeBroadcastAttempt(current.attemptId, 'complete', completionReason)
      },
      (current) => current.closedAt !== null && current.stage === 'complete',
    )
    return completionReason === undefined
      ? stopped
      : this.#store.closeBroadcastAttempt(stopped.attemptId, 'complete', completionReason)
  }

  // ------------------------------------------------------------------- stages

  #beginAttempt(rolloverPredecessorAttemptId?: string): BroadcastAttemptRecord {
    this.#adopted = false
    this.#recoveryReviewedAttemptId = null
    this.#recoveryPredecessorAttemptId = null
    this.#recoveryReplacementAttemptId = null
    const attemptId = this.#newAttemptId()
    // This process made it, so it is already picked up: `#stillResumable` has
    // nothing to ask YouTube about a row it just wrote.
    this.#pickedUpAttemptId = attemptId
    return this.#store.beginBroadcastAttempt({
      attemptId,
      strategy: this.#config.strategy,
      streamTitle: this.#config.stream.title,
      scheduledStartTime: this.#nextScheduledStartTime(),
      attemptMarker: attemptMarkerOf(attemptId),
      ...(rolloverPredecessorAttemptId === undefined ? {} : { rolloverPredecessorAttemptId }),
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
        if (created.privacyStatus !== 'private') {
          throw new Error(
            `broadcast ${created.id} reports privacyStatus ${String(created.privacyStatus)} after private insert`,
          )
        }
        return this.#store.recordBroadcastCallResult(current.attemptId, {
          stage: 'broadcast_created',
          broadcastId: created.id,
          ...(created.liveChatId === null ? {} : { liveChatId: created.liveChatId }),
          autoStart: created.enableAutoStart ?? autoStart,
          privacyStatus: 'private',
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
        // A transition is not finished when the call returns. The reference is
        // explicit about it (`life-of-a-broadcast` step 3.4, checked
        // 2026-08-23): "it may take several seconds, or even up to a minute, for
        // that transition to complete. During that time, you should poll the API
        // to check the broadcast's status. Until the transition is complete, the
        // broadcast's status will be `testStarting`."
        //
        // Asking for the next transition inside that window is refused with
        // `invalidTransition` — measured on the host on 2026-08-23, where
        // `testing` was recorded off the response and `live` was requested a
        // moment later. `redundantTransition` does not cover it: that one is
        // about the *requested* status, and this is a different transition still
        // in flight.
        //
        // Production never hit this before because it went live by auto-start;
        // the explicit path is what a segment rollover uses (T33).
        const settled = await this.#awaitTransition(broadcastId, broadcastStatus, result)
        return stage === 'live'
          ? this.#markLive(current, settled)
          : this.#store.recordBroadcastCallResult(current.attemptId, { stage })
      },
      (current) =>
        stage === 'live' ? current.stage === 'live' : stageAtLeast(current.stage, 'testing'),
    )
  }

  /**
   * Waits for a transition to actually land, and answers with what YouTube last
   * said. `testStarting` and `liveStarting` are the documented in-flight states.
   *
   * It gives up quietly rather than failing: the caller's own retry and
   * reconcile rules already cover a transition that never settles, and a read
   * that times out is not evidence that the transition failed. A broadcast that
   * stays `testStarting` or `liveStarting` is a documented dead end — the
   * reference says such a broadcast has to be deleted, not transitioned — and
   * that is a recovery decision, not something to make inside one call.
   */
  async #awaitTransition(
    broadcastId: string,
    broadcastStatus: 'testing' | 'live',
    fallback: LiveBroadcastSummary,
  ): Promise<LiveBroadcastSummary> {
    const inFlight = broadcastStatus === 'testing' ? 'testStarting' : 'liveStarting'
    const attempts = Math.max(
      1,
      Math.ceil(this.#config.transitionSettleMs / this.#config.statusPollIntervalMs),
    )
    let last = fallback
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (last.lifeCycleStatus !== inFlight) return last
      await this.#sleep(this.#config.statusPollIntervalMs)
      const observed = await this.#readBroadcast(broadcastId)
      if (observed === null) return last
      last = observed
    }
    return last
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
        //
        // The target travels with the reason. `invalidTransition` on its own
        // does not say *which* transition was refused, and `#goLive` asks for
        // two of them in a row — so a failure that reaches a log or a row was
        // ambiguous exactly where it needed not to be (measured 2026-08-23,
        // twice, on two different causes).
        this.#store.recordBroadcastCallResult(attempt.attemptId, {
          lastErrorReason:
            transitionTarget === undefined
              ? (error.reason ?? error.classification.kind)
              : `${error.reason ?? error.classification.kind}:${transitionTarget}`,
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
            ...(found.privacyStatus === 'private' ||
            found.privacyStatus === 'unlisted' ||
            found.privacyStatus === 'public'
              ? { privacyStatus: found.privacyStatus }
              : {}),
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
          ...(observed?.privacyStatus === 'private' ||
          observed?.privacyStatus === 'unlisted' ||
          observed?.privacyStatus === 'public'
            ? { privacyStatus: observed.privacyStatus }
            : {}),
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

  /** Ambiguous topology is not evidence that any one row may be closed. */
  #raiseSafeStop(reason: string, detail: Readonly<Record<string, HealthDetailValue>>): never {
    const at = this.#clock.nowUtcIso()
    this.#alert('safe_stop_requested', reason, detail)
    this.#safeStop({ at, reason, detail })
    throw new BroadcastSafeStopRequiredError(
      reason,
      'open broadcast attempts could not be reconciled without guessing',
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
    const attempt = await this.#resume()
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

  /**
   * FIFO, failure-safe single-flight boundary for every public lifecycle mutation.
   * Composite methods call private implementations while holding it, so there is
   * no reentrant acquisition and therefore no self-wait deadlock.
   */
  async #serializeMutation<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#mutationTail = previous.then(() => gate)
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }
}

/**
 * `lifeCycleStatus` values a stored attempt can still be carried forward on
 * (`LiveBroadcastSummary.lifeCycleStatus`, from the `liveBroadcasts` reference).
 * The two that are missing are the point: `complete` and `revoked` are ends, and
 * an attempt pointing at one of them can only fail (T30).
 */
const RESUMABLE_LIFE_CYCLE_STATUSES: readonly string[] = [
  'created',
  'ready',
  'testStarting',
  'testing',
  'liveStarting',
  'live',
]

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
