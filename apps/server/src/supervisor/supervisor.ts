import type { Clock, TimerHandle } from '../clock.js'
import type { EngineHealth, InputHealth } from '../engine/engine.js'
import type { RendererHealthReport } from '../engine/publisher.js'
import type { HealthSignal, HealthStatus } from '../health/types.js'
import type { CommandMetricsSnapshot } from '../input/metrics.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { AuthEvent, AuthEventSink } from '../youtube/auth/events.js'
import type { SafeStopRequest } from '../youtube/broadcast/alerts.js'
import { createExponentialBackoff, type BackoffPolicy } from '../youtube/quota/backoff.js'
import { nullAlertSink, type Alert, type AlertSeverity, type AlertSink } from './alerts.js'
import type { SupervisorConfig } from './config.js'
import type { DeadManMonitor } from './deadman.js'
import type { KillSwitchRequest } from './kill-switch.js'
import { FilterEvasionDetector, type FilterEvasionState } from './moderation-heuristic.js'
import { runPreflight, type PreflightProbes } from './preflight.js'
import {
  RestartSupervisor,
  SupervisorRegistry,
  type RestartAction,
  type RestartExhaustedEvent,
} from './restart.js'
import type { DiagnosticScreenshotRecorder } from './screenshot.js'
import { HealthAggregator, MODERATION_HEALTHY, type ModerationHealth } from './signals.js'
import { runStartupSequence, type StartupResult, type StartupSteps } from './startup.js'
import { componentsToRestart, nextSupervisorState } from './transitions.js'
import {
  HEALTH_FAMILIES,
  HEALTH_FAMILY_SPEC_ITEM,
  type ComponentHealth,
  type HealthAggregate,
  type ModerationHealthSummary,
  type PreflightResult,
  type SafeStopKind,
  type SafeStopTrigger,
  type SupervisedComponent,
  type SupervisorHealthSummary,
  type SupervisorState,
} from './types.js'

/**
 * The single supervisor of spec §9.2 / §10.2.
 *
 * It is the only thing in the process that turns observations into decisions:
 * the aggregator folds the eight §9.4 signal families, the pure table in
 * `transitions.ts` maps them onto `offline → starting → live → degraded →
 * recovering → live | safe_stopped`, one restart supervisor per component acts,
 * and every state change reaches an operator through `AlertSink`.
 *
 * Three things it deliberately does not do:
 *
 * - it does not restart a component that already owns a restart loop
 *   (`obs-connection` is `ObsClient`'s — spec §10.2 allows exactly one);
 * - it does not leave `safe_stopped` on its own (§9.1, §9.2);
 * - it does not decide anything from a screenshot (§9.4).
 */

/** What the supervisor needs from the state engine — a port, not the class. */
export interface SupervisedEngine {
  health(): EngineHealth
  /** Spec §9.2/§12.3: how the CTA is switched off (`interactionEnabled`). */
  reportInputHealth(health: InputHealth): void
}

export interface ComponentActions {
  readonly engine: RestartAction
  readonly chatSource: RestartAction
  readonly obsStream: RestartAction
  readonly rendererSource: RestartAction
  /**
   * Relaunching OBS itself. The Windows implementation is T17's; until it is
   * injected the action rejects, which is honest — an escalation that cannot
   * act must fail and reach `safe_stopped`, not pretend to have recovered.
   */
  readonly obsProcess: RestartAction
  /**
   * `ObsClient`'s own reconnect counter. The supervisor observes it instead of
   * dialling OBS a second time (spec §10.2).
   */
  readonly obsConnectionAttempts: () => number
}

export interface SupervisorOptions {
  readonly config: SupervisorConfig
  readonly clock: Clock
  readonly engine: SupervisedEngine
  readonly actions: ComponentActions
  /** Last renderer health frame (`RendererHub.lastHealth`), spec §9.4(4). */
  readonly renderer?: () => RendererHealthReport | null
  /**
   * Producers that expose their signals as a snapshot rather than a push (T9's
   * `ChatSource.signals()`). Read at every evaluation, so a source that only
   * emits on change cannot go stale while it is perfectly healthy.
   */
  readonly sources?: () => readonly HealthSignal[]
  readonly alerts?: AlertSink
  readonly deadMan?: DeadManMonitor
  readonly screenshots?: DiagnosticScreenshotRecorder
  readonly preflight?: PreflightProbes
  readonly startup?: StartupSteps
  /**
   * Ends the current broadcast segment and starts the next one if the segment
   * is over (BOARD D-21, TASK_SPECS §T33). Absent when nothing rolls over.
   *
   * The supervisor owns only *when* this may run — the run is live, no swap is
   * already in flight, and outward actions are still allowed. The API order and
   * the chat's move to the new `liveChatId` belong to the caller that has the
   * lifecycle and the listener; putting them here would give the state machine a
   * second job it does not need.
   */
  readonly rollSegment?: () => Promise<void>
  readonly logger?: Logger
  /**
   * Runs once when the machine enters `safe_stopped`: stopping the encoder
   * output, closing the source, whatever this deployment must not leave running.
   * It never restarts anything.
   */
  readonly onSafeStop?: (trigger: SafeStopTrigger) => Promise<void> | void
  /** Injected in tests; defaults to the shared exponential backoff jitter. */
  readonly random?: () => number
  /** Schedule the evaluation loop on `start()`. Off in tests (fake clocks). */
  readonly autoEvaluate?: boolean
  /**
   * Cumulative input counters (`CommandMetrics.snapshot()`), read by the
   * `filter_evasion_surge` heuristic of §12.3 (TASK_SPECS §T22). Absent when
   * nothing in this process parses chat — then the heuristic reports itself as
   * not running rather than as quiet.
   */
  readonly commandMetrics?: () => CommandMetricsSnapshot
}

const OWNER_OBS_CLIENT = 'obs.ObsClient'

export class Supervisor {
  readonly #options: SupervisorOptions
  readonly #config: SupervisorConfig
  readonly #clock: Clock
  readonly #logger: Logger
  readonly #alerts: AlertSink
  readonly #aggregator: HealthAggregator
  readonly #startupBackoff: BackoffPolicy
  readonly registry = new SupervisorRegistry()

  #state: SupervisorState = 'offline'
  #since: string
  #lastTransitionReason = 'not_started'
  #startRequested = false
  #safeStop: SafeStopTrigger | null = null
  #preflight: PreflightResult | null = null
  /** One swap at a time: the API refuses two live broadcasts (T33). */
  #rollingOver = false
  #startupResult: StartupResult | null = null
  #startupAttempts = 0
  #moderation: ModerationHealth = MODERATION_HEALTHY
  #moderationReportedAt: string | null = null
  readonly #filterEvasion: FilterEvasionDetector | null
  #observingHeuristics = false
  #lastEvaluationMonotonicMs: number | null = null
  #lastPreflightMonotonicMs: number | null = null
  #lastAggregate: HealthAggregate | null = null
  #interactionEnabled = true
  #timer: TimerHandle | undefined
  #stopped = false
  /** Tail of the alert delivery queue — see `#alert` (review round 2, B1). */
  #alertQueue: Promise<void> = Promise.resolve()

  constructor(options: SupervisorOptions) {
    this.#options = options
    this.#config = options.config
    this.#clock = options.clock
    this.#logger = options.logger ?? silentLogger
    this.#alerts = options.alerts ?? nullAlertSink
    this.#aggregator = new HealthAggregator(options.config)
    this.#filterEvasion =
      options.commandMetrics === undefined
        ? null
        : new FilterEvasionDetector({
            config: options.config.moderation.heuristics.filterEvasion,
            clock: options.clock,
            metrics: options.commandMetrics,
          })
    this.#since = options.clock.nowUtcIso()
    this.#startupBackoff = createExponentialBackoff({
      initialDelayMs: options.config.restart.initialDelayMs,
      maxDelayMs: options.config.restart.maxDelayMs,
      factor: options.config.restart.factor,
      jitterRatio: options.config.restart.jitterRatio,
      maxAttempts: options.config.startup.maxAttempts,
      ...(options.random === undefined ? {} : { random: options.random }),
    })
    this.#registerComponents()
  }

  /** Sink handed to every health producer (`HealthSignalSink`). */
  readonly report = (signal: HealthSignal): void => {
    this.#aggregator.report(signal)
  }

  get state(): SupervisorState {
    return this.#state
  }

  get aggregate(): HealthAggregate | null {
    return this.#lastAggregate
  }

  get startupResult(): StartupResult | null {
    return this.#startupResult
  }

  /**
   * `offline → starting`, then the §7.3(3) start-up sequence and the §9.2
   * pre-checks. Returns once the sequence has been attempted; the state machine
   * keeps running on the evaluation loop afterwards.
   */
  async start(): Promise<void> {
    this.#startRequested = true
    await this.#evaluate('start_requested')
    if (this.#state === 'safe_stopped') return

    await this.#runStartup()
    // The sequence waits on I/O, so a kill switch or a policy stop can land
    // while it runs. Nothing after it may start something (review round 3).
    if (!this.#outwardActionsAllowed()) return

    this.#options.deadMan?.start()
    this.#options.screenshots?.start()
    await this.#runPreflight()
    await this.#evaluate('startup_complete')
    if (this.#options.autoEvaluate !== false && this.#outwardActionsAllowed()) {
      this.#scheduleNext()
    }
  }

  /** Stops the supervisor's own timers. It never stops the components. */
  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#options.deadMan?.stop()
    this.#options.screenshots?.stop()
  }

  /** One evaluation: aggregate → transition → recovery → CTA. */
  async evaluate(): Promise<HealthAggregate> {
    return this.#evaluate('signals')
  }

  /** Re-runs the `starting` pre-checks (spec §9.2). */
  async runPreflight(): Promise<PreflightResult> {
    const result = await this.#runPreflight()
    await this.#evaluate('preflight')
    return result
  }

  /**
   * Moderation control health (spec §12.3). Reported by whoever observes it.
   *
   * §12.3 defines two levels and this method implements both (review round 1,
   * M2): an unhealthy display filter or block control turns the CTA off and
   * warns, and when safety **cannot be assured** the run stops on top of that.
   * Which reasons mean the second level is a human decision, so it is read from
   * the Gate 0 call table (`supervisor.moderation.safeStopConditions`) rather
   * than invented here — while that list is empty, an unhealthy control turns
   * the CTA off and alerts, and nothing stops the run on its own.
   */
  reportModerationHealth(status: HealthStatus, reason: string | null = null): void {
    const previous = this.#moderation
    const changed = previous.status !== status || previous.reason !== reason
    this.#moderation = { status, reason }
    // The instant belongs to the report, not to the reading of it: a repeat of
    // the same status leaves it where it was, so `/health` keeps saying when the
    // condition actually started (TASK_SPECS §T22: "토큰·시각만").
    if (changed) this.#moderationReportedAt = status === 'ok' ? null : this.#clock.nowUtcIso()
    if (status === 'ok') return
    if (!changed) return

    const token = reason ?? 'moderation_unhealthy'
    const safeStopConditionMatched =
      reason !== null && this.#config.moderation.safeStopConditions.includes(reason)
    // Stage 1 runs even when stage 2 follows (review round 1, B1). An approved
    // token used to return straight out of `requestSafeStop`, so the run stopped
    // with a critical alert and no warning — but §12.3's first stage is not
    // conditional on the second, and the warning is the record of *which*
    // control went unhealthy.
    //
    // Raising it before the stop is what fixes its place in the queue `#alert`
    // keeps (review round 2, B1): the operator reads the warning first however
    // slow the sink is, while the stop below happens at the speed of the
    // process, not of the webhook.
    void this.#alert('warning', 'moderation.unhealthy', {
      reason: token,
      detail: {
        status,
        // Says plainly whether this also stops the run, so an operator reading
        // the alert knows the Gate 0 table is what decides that (spec §12.3).
        safeStopConditionMatched,
        approvedCallTable: this.#config.moderation.approved,
      },
    })
    if (safeStopConditionMatched) {
      void this.requestSafeStop({
        kind: 'moderation_unhealthy',
        at: this.#clock.nowUtcIso(),
        reason: token,
        detail: { status, approvedCallTable: this.#config.moderation.approved },
      })
    }
  }

  /** Adapter for T10's `SafeStopRequestSink` (spec §9.1). */
  readonly onBroadcastSafeStopRequest = (request: SafeStopRequest): void => {
    void this.requestSafeStop({
      kind: 'rights_or_policy',
      at: request.at,
      reason: request.reason,
      detail: request.detail,
    })
  }

  /**
   * Adapter for T3's `AuthEventSink`. A revoked or unrecoverable grant is
   * §9.1's "재동의 필요" — outside the automation boundary, so it stops the run
   * instead of retrying it.
   */
  readonly onAuthEvent = (event: AuthEvent): void => {
    if (event.type === 'auth_revoked') {
      void this.requestSafeStop({
        kind: 'account_action',
        at: event.at,
        reason: `auth_revoked:${event.reason}`,
        detail: { reason: event.reason },
      })
      return
    }
    if (event.type === 'auth_refresh_failed' && !event.retryable) {
      void this.requestSafeStop({
        kind: 'account_action',
        at: event.at,
        reason: `auth_refresh_failed:${event.kind}`,
        detail: { kind: event.kind },
      })
    }
  }

  /** `AuthEventSink` shape, for callers that want the object form. */
  get authEventSink(): AuthEventSink {
    return { emit: this.onAuthEvent }
  }

  /** Any of the three kill-switch paths (spec §11 안전 정지). */
  readonly onKillSwitch = (request: KillSwitchRequest): void => {
    void this.requestSafeStop({
      kind: 'kill_switch',
      at: request.at,
      reason: request.reason,
      detail: { source: request.source },
    })
  }

  /**
   * Enters `safe_stopped`. Idempotent: the first trigger is the one reported,
   * because it is the one that explains the stop.
   */
  async requestSafeStop(trigger: SafeStopTrigger): Promise<void> {
    if (this.#safeStop !== null) return
    this.#safeStop = trigger
    // Everything that *stops* work happens here, synchronously, before the first
    // `await` of this method — telling an operator comes after (review round 4).
    this.#haltOutwardWork()
    this.#logger.error('supervisor safe stop', {
      kind: trigger.kind,
      reason: trigger.reason,
    })
    await this.#evaluate(`safe_stop:${trigger.kind}`)
  }

  /**
   * Cancels every scheduled restart, aborts the ones already running, and stops
   * the supervisor's own loops. Synchronous and idempotent, on purpose.
   *
   * Round 4 found the ordering that made this necessary: the halt used to live
   * after `await`ing the `safe_stopped` alert, so while a Discord webhook was in
   * flight an already-running chat restart finished its `stop()` and went on to
   * `start()` the listener again. Nothing that can block may sit between
   * deciding to stop and stopping — the alert is *reporting*, and reporting
   * never gates safety (spec §9.1, §9.2).
   */
  #haltOutwardWork(): void {
    this.registry.stopAll()
    // Stop pushing the dead-man heartbeat: a stopped broadcast needs a human,
    // and the external monitor is how one is reached when nobody is watching
    // this process's logs ([S23], §11 관측성).
    this.#options.deadMan?.stop()
    this.#options.screenshots?.stop()
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  /** T13 sweep results (`onResult`/`onError`) — see TASK_SPECS §T12 배선. */
  readonly onRetentionResult = (result: {
    readonly clean: boolean
    readonly rowsUnprocessed: number
  }): void => {
    if (result.clean && result.rowsUnprocessed === 0) return
    void this.#alert('warning', 'retention.sweep_incomplete', {
      reason: result.clean ? 'rows_unprocessed' : 'sweep_not_clean',
      detail: { clean: result.clean, rowsUnprocessed: result.rowsUnprocessed },
    })
  }

  /**
   * T13 revocation results. A deletion that missed its deadline or left fields
   * incomplete is a policy obligation this run did not keep (spec §12.4), so it
   * reaches a human rather than a log line.
   */
  readonly onRevocationResult = (result: {
    readonly withinDeadline: boolean
    readonly incomplete: readonly string[]
    readonly reason: string
  }): void => {
    if (result.withinDeadline && result.incomplete.length === 0) return
    void this.#alert('critical', 'privacy.revocation_incomplete', {
      reason: result.withinDeadline ? 'fields_incomplete' : 'deadline_missed',
      detail: {
        revocationReason: result.reason,
        incomplete: result.incomplete.join(',') || null,
      },
    })
  }

  readonly onRetentionError = (error: unknown): void => {
    void this.#alert('warning', 'retention.sweep_failed', {
      reason: 'sweep_error',
      detail: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  health(): SupervisorHealthSummary {
    const aggregate = this.#lastAggregate
    return {
      state: this.#state,
      since: this.#since,
      lastTransitionReason: this.#lastTransitionReason,
      safeStop: this.#safeStop,
      interactionEnabled: this.#interactionEnabled,
      moderation: this.moderationHealth(),
      families: HEALTH_FAMILIES.map((family) => ({
        ...(aggregate?.families[family] ?? {
          family,
          status: 'unknown' as const,
          reason: 'not_evaluated',
          sources: [],
          observedAtUtc: null,
          unknownForMs: null,
          unobservableEscalated: false,
        }),
        specItem: HEALTH_FAMILY_SPEC_ITEM[family],
      })),
      components: this.components(),
      preflight: this.#preflight?.checks ?? [],
      deadMan: this.#options.deadMan?.status() ?? {
        enabled: false,
        lastPushAt: null,
        lastPushOk: null,
        consecutiveFailures: 0,
        lastError: null,
      },
    }
  }

  components(): readonly ComponentHealth[] {
    return this.registry.all().map((supervisor) => supervisor.health())
  }

  /** Spec §12.3 on `/health`: the reported token, when, and the detector. */
  moderationHealth(): ModerationHealthSummary {
    return {
      status: this.#moderation.status,
      reason: this.#moderation.reason,
      reportedAtUtc: this.#moderationReportedAt,
      filterEvasion: this.#filterEvasion?.state() ?? NO_FILTER_EVASION_DETECTOR,
    }
  }

  /**
   * Lets a restart action record something about the attempt it just made, so it
   * reaches `/health` (`components[].lastNote`). Restart actions return `void`,
   * which is what keeps the supervisor out of every component's business; this
   * is the narrow exception D-7 needs — the OBS launcher clearing crash
   * sentinels has to be visible, and inventing a health family for it would
   * feed the §9.2 transition table something that is not a fault.
   */
  noteComponent(component: SupervisedComponent, note: string): void {
    this.registry.get(component)?.note(note)
  }

  // ------------------------------------------------------------- internals

  #registerComponents(): void {
    const { actions } = this.#options
    const backoffFor = (component: SupervisedComponent) =>
      createExponentialBackoff({
        initialDelayMs: this.#config.restart.initialDelayMs,
        maxDelayMs: this.#config.restart.maxDelayMs,
        factor: this.#config.restart.factor,
        jitterRatio: this.#config.restart.jitterRatio,
        maxAttempts: this.#config.restart.maxAttempts[component],
        ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
      })

    const owned: readonly (readonly [SupervisedComponent, RestartAction])[] = [
      ['engine', actions.engine],
      ['chat-source', actions.chatSource],
      ['obs-stream', actions.obsStream],
      ['renderer-source', actions.rendererSource],
      ['obs-process', actions.obsProcess],
    ]
    for (const [component, restart] of owned) {
      this.registry.register(
        new RestartSupervisor({
          component,
          restart,
          backoff: backoffFor(component),
          clock: this.#clock,
          logger: this.#logger,
          onAttempt: (event) => {
            void this.#alert('info', 'supervisor.restart_attempt', {
              reason: `${event.component}:${event.reason}`,
              detail: {
                component: event.component,
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
              },
            })
          },
          onExhausted: (event) => {
            void this.#handleExhausted(event)
          },
          canRestart: () => this.#outwardActionsAllowed(),
        }),
      )
    }

    // The OBS connection already has a restart loop inside `ObsClient` (T2).
    // Spec §10.2 allows exactly one per component, so this entry observes that
    // loop and escalates to the process when it has retried past its budget.
    this.registry.register(
      new RestartSupervisor({
        component: 'obs-connection',
        owner: OWNER_OBS_CLIENT,
        escalatesTo: 'obs-process',
        backoff: backoffFor('obs-connection'),
        clock: this.#clock,
        logger: this.#logger,
        onExhausted: (event) => {
          void this.#handleExhausted(event)
        },
      }),
    )
    this.registry.assertComplete()
  }

  /**
   * The one gate on every **outward** action: a component restart, a start-up
   * step, the evaluation loop's next tick. Once the run has stopped, nothing
   * starts a broadcast, an encoder or a listener again (spec §9.1, §9.2).
   *
   * It is asked before *and after* each await, because both the start-up
   * sequence and a restart action can be waiting on I/O when the stop arrives
   * (review rounds 1 and 3).
   */
  #outwardActionsAllowed(): boolean {
    return this.#safeStop === null && this.#state !== 'safe_stopped' && !this.#stopped
  }

  async #handleExhausted(event: RestartExhaustedEvent): Promise<void> {
    if (event.escalatesTo !== null) {
      const target = this.registry.require(event.escalatesTo)
      await this.#alert('warning', 'supervisor.restart_escalated', {
        reason: `${event.component}->${event.escalatesTo}`,
        detail: { attempts: event.attempts, reason: event.reason },
      })
      // The first attempt of the escalation target starts here; `#driveRecovery`
      // keeps driving it while the condition lasts, so the target really spends
      // its own budget instead of trying once (review round 1, B3).
      target.request(`escalated_from:${event.component}`)
      return
    }
    await this.requestSafeStop({
      kind: 'restart_budget_exhausted',
      at: event.at,
      reason: `${event.component}:${event.reason}`,
      detail: { component: event.component, attempts: event.attempts },
    })
  }

  /**
   * Runs the §7.3(3) sequence, and retries the **whole** sequence with the
   * restart backoff when it fails. A host that comes up before OBS or before its
   * network is the ordinary case (spec §9.1 자동 복구); a sequence that keeps
   * failing after `supervisor.startup.maxAttempts` is §9.2's "최대 재시도 후
   * safe_stopped". Every step is idempotent by construction — `ensureBound()`
   * resumes the open attempt, `startStream()` reports an already-running output —
   * so a retry re-runs the sequence rather than continuing a half-finished one.
   */
  async #runStartup(): Promise<void> {
    if (this.#options.startup === undefined) return
    if (!this.#outwardActionsAllowed()) return
    this.#startupAttempts += 1
    this.#startupResult = await runStartupSequence({
      steps: this.#options.startup,
      clock: this.#clock,
      logger: this.#logger,
      canContinue: () => this.#outwardActionsAllowed(),
    })
    if (this.#startupResult.completed) return
    if (this.#startupResult.aborted) {
      // The run stopped mid-sequence. That is not a start-up failure: it spends
      // no retry, raises no failure alert, and above all starts nothing.
      this.#logger.warn('startup abandoned: the run has stopped', {
        attempt: this.#startupAttempts,
      })
      return
    }

    const maxAttempts = this.#config.startup.maxAttempts
    await this.#alert('warning', 'supervisor.startup_failed', {
      reason: this.#startupResult.failedStep ?? 'unknown_step',
      detail: {
        error: this.#startupResult.error,
        attempt: this.#startupAttempts,
        maxAttempts,
      },
    })
    if (this.#startupAttempts >= maxAttempts) {
      await this.requestSafeStop({
        kind: 'restart_budget_exhausted',
        at: this.#clock.nowUtcIso(),
        reason: `startup:${this.#startupResult.failedStep ?? 'unknown_step'}`,
        detail: { attempts: this.#startupAttempts, error: this.#startupResult.error },
      })
      return
    }
    const delayMs = this.#startupBackoff.nextDelayMs(this.#startupAttempts)
    this.#clock.setTimeout(() => {
      if (this.#stopped || this.#state === 'safe_stopped') return
      void this.#runStartup().then(async () => {
        await this.#runPreflight()
        await this.#evaluate('startup_retry')
      })
    }, delayMs)
  }

  async #runPreflight(): Promise<PreflightResult> {
    if (this.#options.preflight === undefined) {
      // No probes injected (unit tests, and the bare health server of T0):
      // "not checked" must not read as "passed".
      this.#preflight = {
        passed: false,
        at: this.#clock.nowUtcIso(),
        checks: [],
        failed: [],
        safeStop: null,
      }
      return this.#preflight
    }
    this.#lastPreflightMonotonicMs = this.#clock.monotonicMs()
    const result = await runPreflight(this.#options.preflight, this.#clock)
    this.#preflight = result
    if (result.safeStop !== null) {
      await this.requestSafeStop(result.safeStop)
    } else if (!result.passed) {
      await this.#alert('warning', 'supervisor.preflight_failed', {
        reason: result.failed.join('+'),
        detail: Object.fromEntries(
          result.checks.map((check) => [check.check, check.passed ? 'ok' : (check.reason ?? '')]),
        ),
      })
    }
    return result
  }

  /**
   * Re-runs the `starting` pre-checks while they are failing for a reason a
   * retry can fix (review round 1, M1).
   *
   * The first run happens in `start()`, but a renderer that attaches a minute
   * later, an encoder that finishes booting, or an API that comes back are all
   * §9.1 "일시 장애 자동 복구" cases — and the machine cannot leave `starting`
   * until the checks are re-read. It is rate-limited by
   * `supervisor.preflightRetryIntervalMs` because the `secrets` probe reads the
   * OS credential vault, which is not free.
   */
  async #maybeRetryPreflight(): Promise<void> {
    if (this.#state !== 'starting' || this.#options.preflight === undefined) return
    const previous = this.#preflight
    if (previous === null || previous.passed || previous.safeStop !== null) return
    if (
      this.#lastPreflightMonotonicMs !== null &&
      this.#clock.monotonicMs() - this.#lastPreflightMonotonicMs <
        this.#config.preflightRetryIntervalMs
    ) {
      return
    }
    await this.#runPreflight()
  }

  /**
   * Whether component recovery may act. A run with no start-up sequence — the
   * bare health server, and most tests — has nothing to wait for; one that has a
   * sequence waits until it has finished walking it, successfully or not.
   */
  #startupSettled(): boolean {
    if (this.#options.startup === undefined) return true
    return this.#startupResult !== null
  }

  async #evaluate(cause: string): Promise<HealthAggregate> {
    this.#observeModerationHeuristics()
    await this.#maybeRetryPreflight()
    const nowMonotonicMs = this.#clock.monotonicMs()
    for (const signal of this.#options.sources?.() ?? []) this.#aggregator.report(signal)
    const engine = this.#options.engine.health()
    const aggregate = this.#aggregator.evaluate({
      engine,
      renderer: this.#options.renderer?.() ?? null,
      deadMan: this.#options.deadMan?.status() ?? {
        enabled: false,
        lastPushAt: null,
        lastPushOk: null,
        consecutiveFailures: 0,
        lastError: null,
      },
      moderation: this.#moderation,
      lastEvaluationMonotonicMs: this.#lastEvaluationMonotonicMs,
      nowUtc: this.#clock.nowUtcIso(),
      nowMonotonicMs,
    })
    this.#lastEvaluationMonotonicMs = nowMonotonicMs
    this.#lastAggregate = aggregate

    // §12.3: an unhealthy moderation control turns the CTA off first, and stops
    // the run only if safety cannot be assured. That second step is a human
    // judgement, so it is a configured safe-stop condition rather than an
    // automatic one — the supervisor never invents the escalation.
    this.#applyInteractionGate(aggregate)

    const recovering = this.registry.all().some((supervisor) => supervisor.inFlight)
    const transition = nextSupervisorState(this.#state, {
      aggregate,
      preflight: this.#preflight,
      recovering,
      safeStop: this.#safeStop,
      startRequested: this.#startRequested,
    })

    if (transition.changed) {
      this.#state = transition.to
      this.#since = aggregate.atUtc
      this.#lastTransitionReason = transition.reason
      await this.#onEnter(transition.to, transition.reason, cause, aggregate)
    } else {
      this.#lastTransitionReason = transition.reason
    }

    // Recovery is for a running system. While the start-up sequence is still
    // walking its fixed order, that order is what owns the components — and a
    // restart fired underneath it undoes the step it is standing on.
    //
    // Measured on the host on 2026-08-23: `obs-stream` recovery started the
    // encoder before the sequence reached its `streamService` step, and OBS
    // refuses to accept a stream service while streaming. The sequence then
    // failed on that step every time, five attempts running, and the host could
    // not broadcast at all (TASK_SPECS §T37).
    //
    // Fourth defect of the same shape today, after T28, T30 and T35: a recovery
    // action firing before the thing it depends on exists.
    if (this.#state !== 'safe_stopped' && this.#startupSettled()) {
      this.#driveRecovery(aggregate)
    }
    // Only a run that is actually live has a segment to end (T33). Deliberately
    // *not* awaited: a swap is several API calls, and an evaluation loop that
    // waits for them is an evaluation loop that stops answering — the
    // coordinator heartbeat would degrade and take the run down for a reason
    // that has nothing to do with the swap. `#rollingOver` is what keeps two
    // swaps from overlapping, which is the thing the API actually refuses.
    if (this.#state === 'live') void this.#rolloverIfDue()
    return aggregate
  }

  /**
   * One segment boundary (BOARD D-21). The lifecycle owns the API order — new
   * broadcast on the same stream, old one completed, new one live — and this
   * only decides *when* to ask and what to do afterwards.
   *
   * The caller also moves the chat: the old `liveChatId` dies with the old
   * broadcast, and a source left pointing at one answers `FAILED_PRECONDITION`
   * (measured in T30).
   */
  async #rolloverIfDue(): Promise<void> {
    const roll = this.#options.rollSegment
    if (roll === undefined || this.#rollingOver) return
    if (!this.#outwardActionsAllowed()) return

    this.#rollingOver = true
    try {
      await roll()
    } catch (error) {
      // A failed swap is not a reason to stop: the previous broadcast is either
      // still live or already ended by YouTube, and the next tick asks again.
      // Reported, never silent (spec §9.1).
      const message = error instanceof Error ? error.message : String(error)
      this.#logger.error('broadcast segment rollover failed', { error: message })
      await this.#alert('warning', 'supervisor.rollover_failed', {
        reason: 'rollover_failed',
        detail: { error: message },
      })
    } finally {
      this.#rollingOver = false
    }
  }

  /**
   * Runs the automatic `filter_evasion_surge` detector for one evaluation
   * (spec §12.3, TASK_SPECS §T22).
   *
   * Re-entrant on purpose-proofing: reporting an approved token reaches
   * `requestSafeStop`, which evaluates again synchronously, and the detector
   * must not be asked for a second verdict inside its own. The nested pass skips
   * it and the outer one has already applied the verdict.
   */
  #observeModerationHeuristics(): void {
    if (this.#filterEvasion === null || this.#observingHeuristics) return
    this.#observingHeuristics = true
    try {
      const verdict = this.#filterEvasion.observe()
      if (verdict === 'report') {
        this.reportModerationHealth('degraded', 'filter_evasion_surge')
      } else if (verdict === 'clear') {
        // Only the detector's own report is cleared here. A person's report of
        // another token is theirs to clear (`POST /admin/moderation/clear`), and
        // a run already stopped stays stopped either way (spec §9.2).
        if (this.#moderation.reason === 'filter_evasion_surge') {
          this.reportModerationHealth('ok')
        }
      }
    } finally {
      this.#observingHeuristics = false
    }
  }

  #applyInteractionGate(aggregate: HealthAggregate): void {
    const enabled = aggregate.inputHealthy && this.#safeStop === null
    this.#interactionEnabled = enabled
    // The engine owns `interactionEnabled` in the published read model; the
    // supervisor instructs it through the input-health port rather than
    // computing a second, competing answer (spec §9.2, TASK_SPECS §T12).
    this.#options.engine.reportInputHealth(enabled ? 'ok' : 'degraded')
  }

  /**
   * Asks the responsible component's single supervisor to act (spec §10.2).
   *
   * The escalation edge needs care (review round 1, B3). While the OBS
   * connection stays unreachable, the *signal* keeps naming `obs-connection`;
   * the component that can still do something about it is `obs-process`. So an
   * exhausted component with a declared escalation target hands the work to that
   * target on every pass, and the target is not told it is healthy just because
   * no signal names it directly — otherwise its budget resets after each failed
   * attempt and `safe_stopped` is never reached.
   */
  #driveRecovery(aggregate: HealthAggregate): void {
    const reason = aggregate.degradedFamilies.join('+')
    const wanted = new Set<SupervisedComponent>(componentsToRestart(aggregate))
    for (const component of [...wanted]) {
      const supervisor = this.registry.get(component)
      if (supervisor?.exhausted === true && supervisor.escalatesTo !== null) {
        wanted.add(supervisor.escalatesTo)
      }
    }

    for (const supervisor of this.registry.all()) {
      if (!wanted.has(supervisor.component)) {
        supervisor.noteHealthy()
        continue
      }
      if (supervisor.delegated) {
        const attempts =
          supervisor.component === 'obs-connection'
            ? this.#options.actions.obsConnectionAttempts()
            : 0
        supervisor.observeExternalAttempts(attempts, reason)
        continue
      }
      // An exhausted component whose work has been handed on stays exhausted:
      // `request()` answers `exhausted` and the target above does the acting.
      supervisor.request(reason)
    }
  }

  async #onEnter(
    state: SupervisorState,
    reason: string,
    cause: string,
    aggregate: HealthAggregate,
  ): Promise<void> {
    this.#logger.info('supervisor state', { state, reason, cause })
    // Idempotent, and deliberately ahead of every `await` below: whichever path
    // reached `safe_stopped`, nothing is left scheduled or running by the time
    // anything can block (review rounds 1 and 4; spec §9.1, §9.2).
    if (state === 'safe_stopped') this.#haltOutwardWork()

    const severity: AlertSeverity =
      state === 'safe_stopped' ? 'critical' : state === 'degraded' ? 'warning' : 'info'
    await this.#alert(severity, `supervisor.${state}`, {
      reason,
      detail: {
        degradedFamilies: aggregate.degradedFamilies.join(',') || null,
        unknownFamilies: aggregate.unknownFamilies.join(',') || null,
        interactionEnabled: this.#interactionEnabled,
      },
    })

    if (state === 'safe_stopped') {
      if (this.#options.onSafeStop !== undefined && this.#safeStop !== null) {
        try {
          await this.#options.onSafeStop(this.#safeStop)
        } catch (error) {
          this.#logger.error('safe stop handler failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  /**
   * Hands one alert to the sink, after every alert raised before it.
   *
   * Round 2 (B1) found why the order has to be enforced here. §12.3's two
   * stages were started concurrently — `void this.#alert(warning)` and then the
   * safe stop, whose own critical alert is raised a few `await`s later — so a
   * sink that takes any time at all could deliver `supervisor.safe_stopped`
   * first and an operator would read the stop before the reason for it. The
   * reviewer's probe, with a sink that blocked only `moderation.unhealthy`:
   * `before_warning_release=["supervisor.safe_stopped"]`. Delivery order is now
   * call order, because each delivery waits for the queue ahead of it.
   *
   * Reporting still never gates safety (spec §9.1, §9.2). Everything that stops
   * work — `#haltOutwardWork()`, the state assignment, the CTA gate — runs
   * before any of these promises is awaited, so a slow sink delays the telling
   * and never the stopping.
   */
  #alert(
    severity: AlertSeverity,
    kind: string,
    body: { readonly reason: string; readonly detail: Alert['detail'] },
  ): Promise<void> {
    // Stamped when the condition was observed, not when the queue reaches it.
    const alert: Alert = {
      kind,
      severity,
      at: this.#clock.nowUtcIso(),
      reason: body.reason,
      detail: body.detail,
    }
    const delivered = this.#alertQueue.then(() => this.#deliverAlert(alert))
    this.#alertQueue = delivered
    return delivered
  }

  /**
   * One queued delivery, bounded by `alerts.deliveryTimeoutMs`. The bound is
   * what keeps the queue from becoming a new way to lose an alert: a transport
   * that never answers stops holding the alerts behind it, so the critical one
   * still reaches a human. Never rejects — `#deliverOnce` absorbs the failure.
   */
  async #deliverAlert(alert: Alert): Promise<void> {
    let timer: TimerHandle | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = this.#clock.setTimeout(() => {
        resolve('timeout')
      }, this.#config.alerts.deliveryTimeoutMs)
    })
    const outcome = await Promise.race([this.#deliverOnce(alert), timedOut])
    if (timer !== undefined) this.#clock.clearTimeout(timer)
    if (outcome === 'timeout') {
      this.#logger.error('alert delivery timed out', {
        kind: alert.kind,
        sink: this.#alerts.name,
        timeoutMs: this.#config.alerts.deliveryTimeoutMs,
      })
    }
  }

  /** The sink call itself. Never rejects: a sink that throws is logged. */
  async #deliverOnce(alert: Alert): Promise<void> {
    try {
      await this.#alerts.deliver(alert)
    } catch (error) {
      // An alert sink that throws must not take the supervisor with it.
      this.#logger.error('alert sink threw', {
        kind: alert.kind,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #scheduleNext(): void {
    if (this.#stopped || this.#state === 'safe_stopped') return
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      void this.#evaluate('tick').then(() => {
        this.#scheduleNext()
      })
    }, this.#config.evaluateIntervalMs)
  }
}

/** What `/health` shows when no chat parser feeds the detector. */
const NO_FILTER_EVASION_DETECTOR: FilterEvasionState = Object.freeze({
  enabled: false,
  reported: false,
  consecutiveExceeding: 0,
  consecutiveBelow: 0,
  windowsClosed: 0,
  lastWindow: null,
})

export type { SafeStopKind }
