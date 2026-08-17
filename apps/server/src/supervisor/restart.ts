import type { Clock } from '../clock.js'
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

export type RestartAction = () => Promise<void>

export type RestartRequestOutcome =
  /** An attempt was scheduled (after backoff) or is already running. */
  | 'scheduled'
  | 'in_flight'
  /** The attempt budget is gone; the caller escalates or stops (spec §9.2). */
  | 'exhausted'

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
  #exhausted = false
  #lastAttemptAt: string | null = null
  #lastError: string | null = null

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
    }
  }

  /**
   * The component is healthy again: the budget is returned. Until this is
   * called, attempts accumulate — a component that keeps failing after each
   * restart is exactly the case §9.2 wants to end in `safe_stopped`.
   */
  noteHealthy(): void {
    if (this.#inFlight) return
    this.#attempts = 0
    this.#exhausted = false
    this.#lastError = null
  }

  /** Asks for one restart. Never rejects: the failure is recorded and counted. */
  request(reason: string): RestartRequestOutcome {
    if (this.delegated) {
      throw new DelegatedRestartError(this.component, this.owner)
    }
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

    this.#clock.setTimeout(() => {
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
    try {
      await restart()
      this.#lastError = null
      this.#logger.info('supervisor restart completed', {
        component: this.component,
        attempt: this.#attempts,
        reason,
      })
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      this.#logger.error('supervisor restart failed', {
        component: this.component,
        attempt: this.#attempts,
        reason,
        error: this.#lastError,
      })
    } finally {
      this.#inFlight = false
      if (this.#attempts >= this.#options.backoff.maxAttempts && this.#lastError !== null) {
        this.#markExhausted(reason)
      }
    }
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

  /** Every supervised component is covered; used at start-up and by the tests. */
  assertComplete(): void {
    const missing = SUPERVISED_COMPONENTS.filter((component) => !this.#byComponent.has(component))
    if (missing.length > 0) throw new MissingSupervisorError(missing)
  }
}
