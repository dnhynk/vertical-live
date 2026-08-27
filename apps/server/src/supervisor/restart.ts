import type { Clock, TimerHandle } from '../clock.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { BackoffPolicy } from '../youtube/quota/backoff.js'
import { SUPERVISED_COMPONENTS, type ComponentHealth, type SupervisedComponent } from './types.js'

/**
 * Restart supervision, spec §10.2: **"하나의 component에는 하나의 restart
 * supervisor만 둔다."**
 *
 * Two ownership models exist, and the distinction is the whole point of this
 * module:
 *
 * - **supervisor-owned** — the component has no recovery loop of its own, so
 *   this class runs one: backoff, bounded attempts, and `safe_stopped` (or a
 *   declared escalation) when the budget is gone (spec §9.2).
 * - **delegated** — the component already owns a loop (`ObsClient` reconnects on
 *   its own since T2). T12 must not add a second one, so the entry only
 *   *observes* the owner's attempt counter. Calling `request()` on it throws:
 *   the invariant is enforced by the type of the entry, not by a comment.
 *
 * `SupervisorRegistry` enforces the other half — at most one entry per
 * component, and every component covered.
 */

/**
 * One restart attempt.
 *
 * The `signal` is aborted the moment the run stops. An action that awaits
 * anything **must check it again before every outward effect**: cancelling a
 * timer cannot unwind an action that is already inside its `await`, and the chat
 * restart — `stop()` then `start()` — is exactly the shape that would otherwise
 * start a listener after `safe_stopped` (review round 3).
 */
export type RestartAction = (signal: AbortSignal) => Promise<void> | void

export type RestartRequestOutcome =
  /** An attempt was scheduled (after backoff) or is already running. */
  | 'scheduled'
  | 'in_flight'
  /** The attempt budget is gone; the caller escalates or stops (spec §9.2). */
  | 'exhausted'
  /** The run has stopped for good; nothing restarts any more (spec §9.1, §9.2). */
  | 'stopped'

export interface RestartSupervisorOptions {
  readonly component: SupervisedComponent
  readonly backoff: BackoffPolicy
  readonly clock: Clock
  /**
   * Present for supervisor-owned components only. Absent means the loop is
   * owned elsewhere (`owner` names it) and this entry observes rather than acts.
   */
  readonly restart?: RestartAction
  /** Module that owns the loop when it is not this one, e.g. `obs.ObsClient`. */
  readonly owner?: string
  /**
   * Component to hand over to when this one runs out of attempts. Without it,
   * exhaustion means `safe_stopped` (spec §9.2). With it, exhaustion means "this
   * layer cannot fix it, try the one underneath" — the OBS connection handing
   * over to the OBS process is the only such pair in V1.
   */
  readonly escalatesTo?: SupervisedComponent
  readonly logger?: Logger
  readonly onAttempt?: (event: RestartAttemptEvent) => void
  readonly onExhausted?: (event: RestartExhaustedEvent) => void
  /**
   * Checked again in the moment before the scheduled action runs. `stop()`
   * already cancels the timer, but a restart is an *outward* action — it starts
   * an encoder — so it also asks, immediately before acting, whether restarting
   * is still allowed. Belt and braces: review round 1 (B1) found a restart that
   * had been scheduled before a `rights_or_policy` stop still running after it,
   * which is exactly the automatic restart spec §9.1/§9.2 prohibit.
   */
  readonly canRestart?: () => boolean
  /**
   * Keep a successful action in flight until the next aggregate says this
   * component is healthy. Command completion and recovery are different
   * boundaries for remote systems: OBS can accept `StartStream` before YouTube
   * reports active ingest (T51). If health never confirms recovery, the attempt
   * fails after this window and the existing backoff/budget continues.
   */
  readonly recoveryTimeoutMs?: number
  /**
   * Versioned positive observation required to finish post-action recovery.
   * The version must advance after the action returns and `recovered` must
   * still be true when health is acknowledged. This prevents an old healthy
   * aggregate, or a different signal in the same family, from returning the
   * attempt budget (T51 review round 1).
   */
  readonly recoveryObservation?: () => RecoveryObservation
}

export interface RecoveryObservation {
  /** Monotonically increasing for every fresh canonical observation. */
  readonly version: number
  /** True only when that latest observation explicitly proves recovery. */
  readonly recovered: boolean
}

export interface RestartAttemptEvent {
  readonly component: SupervisedComponent
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly reason: string
  readonly at: string
}

export interface RestartExhaustedEvent {
  readonly component: SupervisedComponent
  readonly attempts: number
  readonly reason: string
  readonly escalatesTo: SupervisedComponent | null
  readonly at: string
}

/** Thrown when something tries to restart a component it does not supervise. */
export class DelegatedRestartError extends Error {
  constructor(component: SupervisedComponent, owner: string) {
    super(
      `restart of ${component} is owned by ${owner}; a second restart supervisor would violate spec §10.2`,
    )
    this.name = 'DelegatedRestartError'
  }
}

export class RestartSupervisor {
  readonly component: SupervisedComponent
  readonly owner: string
  readonly escalatesTo: SupervisedComponent | null

  readonly #options: RestartSupervisorOptions
  readonly #clock: Clock
  readonly #logger: Logger

  #attempts = 0
  #inFlight = false
  #verifyingRecovery = false
  #recoveryObservationVersionAtStart: number | undefined
  #exhausted = false
  #stopped = false
  #timer: TimerHandle | undefined
  #abort: AbortController | undefined
  #lastAttemptAt: string | null = null
  #lastError: string | null = null
  #lastNote: string | null = null

  constructor(options: RestartSupervisorOptions) {
    this.#options = options
    this.component = options.component
    this.owner = options.owner ?? 'supervisor'
    this.escalatesTo = options.escalatesTo ?? null
    this.#clock = options.clock
    this.#logger = options.logger ?? silentLogger
    if (options.restart === undefined && options.owner === undefined) {
      throw new Error(`${options.component}: a supervisor-owned component needs a restart action`)
    }
    if (
      options.recoveryTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.recoveryTimeoutMs) || options.recoveryTimeoutMs <= 0)
    ) {
      throw new RangeError(
        `${options.component}: recoveryTimeoutMs must be a positive safe integer`,
      )
    }
  }

  get delegated(): boolean {
    return this.#options.restart === undefined
  }

  get attempts(): number {
    return this.#attempts
  }

  get inFlight(): boolean {
    return this.#inFlight
  }

  get exhausted(): boolean {
    return this.#exhausted
  }

  /** True once `stop()` has been called; nothing restarts after that. */
  get stopped(): boolean {
    return this.#stopped
  }

  /**
   * Cancels the scheduled attempt, if any, and refuses every later one. The
   * supervisor calls this on entering `safe_stopped`: a run that stopped for a
   * rights, policy or integrity reason must not restart a component afterwards
   * (spec §9.1, §9.2), and a restart already waiting out its backoff is exactly
   * such a restart.
   */
  stop(): void {
    this.#stopped = true
    this.#cancelPending()
    // An attempt already inside its `await` cannot be unwound, so it is told:
    // the action checks the signal before whatever it does next.
    this.#abort?.abort()
    this.#abort = undefined
  }

  #cancelPending(): void {
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#verifyingRecovery = false
    this.#recoveryObservationVersionAtStart = undefined
    this.#inFlight = false
  }

  health(): ComponentHealth {
    return {
      component: this.component,
      owner: this.owner,
      attempts: this.#attempts,
      maxAttempts: this.#options.backoff.maxAttempts,
      exhausted: this.#exhausted,
      inFlight: this.#inFlight,
      lastAttemptAt: this.#lastAttemptAt,
      lastError: this.#lastError,
      lastNote: this.#lastNote,
    }
  }

  /**
   * Records what the restart action itself observed, for `/health`. A
   * `RestartAction` returns `void` — it cannot hand anything back — so the
   * action calls this instead (`Supervisor.noteComponent()`). It is not cleared
   * by `noteHealthy()`: the OBS launcher's sentinel count (BOARD D-7) is a fact
   * about the last launch, and a healthy component has not un-launched it.
   */
  note(note: string): void {
    this.#lastNote = note
  }

  /**
   * The component is healthy again: the budget is returned. Until this is
   * called, attempts accumulate — a component that keeps failing after each
   * restart is exactly the case §9.2 wants to end in `safe_stopped`.
   */
  noteHealthy(): void {
    if (this.#stopped) return
    // Backoff and the action itself remain protected from a transient healthy
    // sample. Once the action has returned, however, this is the canonical
    // acknowledgement it was waiting for (T51).
    if (this.#inFlight && !this.#verifyingRecovery) return
    if (this.#verifyingRecovery) {
      const observationVersionAtStart = this.#recoveryObservationVersionAtStart
      if (observationVersionAtStart !== undefined) {
        const observation = this.#options.recoveryObservation?.()
        if (
          observation === undefined ||
          !observation.recovered ||
          observation.version <= observationVersionAtStart
        ) {
          return
        }
      }
      if (this.#timer !== undefined) {
        this.#clock.clearTimeout(this.#timer)
        this.#timer = undefined
      }
      this.#verifyingRecovery = false
      this.#recoveryObservationVersionAtStart = undefined
      this.#inFlight = false
      this.#logger.info('supervisor restart recovery verified', {
        component: this.component,
        attempt: this.#attempts,
      })
    }
    this.#attempts = 0
    this.#exhausted = false
    this.#lastError = null
  }

  /** Asks for one restart. Never rejects: the failure is recorded and counted. */
  request(reason: string): RestartRequestOutcome {
    if (this.delegated) {
      throw new DelegatedRestartError(this.component, this.owner)
    }
    if (this.#stopped) return 'stopped'
    if (this.#exhausted) return 'exhausted'
    if (this.#inFlight) return 'in_flight'

    const attempt = this.#attempts + 1
    if (attempt > this.#options.backoff.maxAttempts) {
      this.#markExhausted(reason)
      return 'exhausted'
    }

    this.#attempts = attempt
    this.#inFlight = true
    const delayMs = this.#options.backoff.nextDelayMs(attempt)
    const at = this.#clock.nowUtcIso()
    this.#lastAttemptAt = at
    this.#options.onAttempt?.({
      component: this.component,
      attempt,
      maxAttempts: this.#options.backoff.maxAttempts,
      delayMs,
      reason,
      at,
    })

    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      void this.#run(reason)
    }, delayMs)
    return 'scheduled'
  }

  /**
   * Delegated entries only: mirror the owner's own attempt counter. When it
   * passes the budget the entry is exhausted exactly like a supervisor-owned
   * one, so the escalation and `safe_stopped` rules stay in one place.
   */
  observeExternalAttempts(attempts: number, reason: string): RestartRequestOutcome {
    if (!this.delegated) {
      throw new Error(`${this.component}: observeExternalAttempts is for delegated entries only`)
    }
    if (this.#stopped) return 'stopped'
    if (this.#exhausted) return 'exhausted'
    this.#attempts = attempts
    this.#lastAttemptAt = this.#clock.nowUtcIso()
    if (attempts >= this.#options.backoff.maxAttempts) {
      this.#markExhausted(reason)
      return 'exhausted'
    }
    return 'in_flight'
  }

  async #run(reason: string): Promise<void> {
    const restart = this.#options.restart
    if (restart === undefined) return
    // Last gate before an outward action. `stop()` normally cancels the timer
    // first; this covers the attempt that was already inside the timer callback
    // when the run stopped (review round 1, B1).
    if (this.#stopped || this.#options.canRestart?.() === false) {
      this.#inFlight = false
      this.#logger.warn('supervisor restart skipped: the run has stopped', {
        component: this.component,
        attempt: this.#attempts,
        reason,
      })
      return
    }
    const abort = new AbortController()
    this.#abort = abort
    let awaitingRecovery = false
    try {
      await restart(abort.signal)
      if (abort.signal.aborted) {
        // The run stopped while the action was awaiting. Whatever it managed to
        // do, it is not a completed restart and it is not counted as one.
        this.#logger.warn('supervisor restart abandoned: the run stopped mid-action', {
          component: this.component,
          attempt: this.#attempts,
          reason,
        })
        return
      }
      this.#lastError = null
      const recoveryTimeoutMs = this.#options.recoveryTimeoutMs
      if (recoveryTimeoutMs === undefined) {
        this.#logger.info('supervisor restart completed', {
          component: this.component,
          attempt: this.#attempts,
          reason,
        })
      } else {
        this.#beginRecoveryVerification(reason, recoveryTimeoutMs)
        awaitingRecovery = true
      }
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#logger.error('supervisor restart failed', {
        component: this.component,
        attempt: this.#attempts,
        reason,
        error: this.#lastError,
      })
    } finally {
      if (this.#abort === abort) this.#abort = undefined
      if (!awaitingRecovery) this.#inFlight = false
      if (
        !this.#stopped &&
        this.#attempts >= this.#options.backoff.maxAttempts &&
        this.#lastError !== null
      ) {
        this.#markExhausted(reason)
      }
    }
  }

  #beginRecoveryVerification(reason: string, timeoutMs: number): void {
    this.#recoveryObservationVersionAtStart = this.#options.recoveryObservation?.().version
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      if (!this.#verifyingRecovery || this.#stopped) return
      this.#verifyingRecovery = false
      this.#recoveryObservationVersionAtStart = undefined
      this.#inFlight = false
      this.#lastError = `health recovery was not observed within ${timeoutMs}ms`
      this.#logger.error('supervisor restart health recovery timed out', {
        component: this.component,
        attempt: this.#attempts,
        reason,
        timeoutMs,
      })
      if (this.#attempts >= this.#options.backoff.maxAttempts) {
        this.#markExhausted(reason)
      }
    }, timeoutMs)
    this.#verifyingRecovery = true
    this.#logger.info('supervisor restart action completed; awaiting health recovery', {
      component: this.component,
      attempt: this.#attempts,
      reason,
      timeoutMs,
    })
  }

  #markExhausted(reason: string): void {
    if (this.#exhausted) return
    this.#exhausted = true
    this.#options.onExhausted?.({
      component: this.component,
      attempts: this.#attempts,
      reason,
      escalatesTo: this.escalatesTo,
      at: this.#clock.nowUtcIso(),
    })
  }
}

export class DuplicateSupervisorError extends Error {
  constructor(component: SupervisedComponent) {
    super(`component ${component} already has a restart supervisor (spec §10.2)`)
    this.name = 'DuplicateSupervisorError'
  }
}

export class MissingSupervisorError extends Error {
  constructor(components: readonly SupervisedComponent[]) {
    super(`components without a restart supervisor: ${components.join(', ')}`)
    this.name = 'MissingSupervisorError'
  }
}

/** One entry per component, no more and no fewer (spec §10.2). */
export class SupervisorRegistry {
  readonly #byComponent = new Map<SupervisedComponent, RestartSupervisor>()

  register(supervisor: RestartSupervisor): RestartSupervisor {
    if (this.#byComponent.has(supervisor.component)) {
      throw new DuplicateSupervisorError(supervisor.component)
    }
    this.#byComponent.set(supervisor.component, supervisor)
    return supervisor
  }

  get(component: SupervisedComponent): RestartSupervisor | undefined {
    return this.#byComponent.get(component)
  }

  require(component: SupervisedComponent): RestartSupervisor {
    const supervisor = this.#byComponent.get(component)
    if (supervisor === undefined) throw new MissingSupervisorError([component])
    return supervisor
  }

  all(): readonly RestartSupervisor[] {
    return [...this.#byComponent.values()]
  }

  /**
   * Cancels every scheduled restart and refuses further ones. Called once, on
   * entering `safe_stopped` (spec §9.1, §9.2).
   */
  stopAll(): void {
    for (const supervisor of this.#byComponent.values()) supervisor.stop()
  }

  /** Every supervised component is covered; used at start-up and by the tests. */
  assertComplete(): void {
    const missing = SUPERVISED_COMPONENTS.filter((component) => !this.#byComponent.has(component))
    if (missing.length > 0) throw new MissingSupervisorError(missing)
  }
}
