import type { HealthDetailValue, HealthStatus } from '../health/types.js'

/**
 * The supervisor's vocabulary (spec §9.2, §9.4, §10.2).
 *
 * Producers report (`HealthSignal`, T2/T9/T10) and components act; nothing but
 * the aggregator in `signals.ts` and the pure transition table in
 * `transitions.ts` decides what a combination of reports *means*.
 */

/** Spec §9.2: `offline → starting → live → degraded → recovering → live | safe_stopped`. */
export const SUPERVISOR_STATES = [
  'offline',
  'starting',
  'live',
  'degraded',
  'recovering',
  'safe_stopped',
] as const

export type SupervisorState = (typeof SUPERVISOR_STATES)[number]

/**
 * The eight minimum health signals of spec §9.4, one family per numbered item:
 *
 * 1. coordinator heartbeat
 * 2. last committed state transition
 * 3. YouTube chat transport / keepalive / reconnect / last user event
 * 4. renderer heartbeat, frame counter, applied+acked revision, FPS, WebGL
 * 5. OBS stream active/reconnecting and byte·duration progress
 * 6. `liveStreams.status` + configuration issues + `liveBroadcasts` lifecycle
 * 7. congestion, skipped·dropped frames
 * 8. external dead-man monitor and off-host availability
 */
export const HEALTH_FAMILIES = [
  'coordinator',
  'state_commit',
  'chat_transport',
  'renderer',
  'obs_output',
  'youtube_broadcast',
  'frame_loss',
  'dead_man',
] as const

export type HealthFamily = (typeof HEALTH_FAMILIES)[number]

/** Which spec §9.4 item each family covers, reported on `/health` verbatim. */
export const HEALTH_FAMILY_SPEC_ITEM: Readonly<Record<HealthFamily, number>> = Object.freeze({
  coordinator: 1,
  state_commit: 2,
  chat_transport: 3,
  renderer: 4,
  obs_output: 5,
  youtube_broadcast: 6,
  frame_loss: 7,
  dead_man: 8,
})

export interface FamilyVerdict {
  readonly family: HealthFamily
  /**
   * What the reports say. `unknown` means "not observed" — by itself it is not a
   * fault, which is why it is kept distinct from `degraded` all the way to the
   * transition table (spec §9.4(3)).
   */
  readonly status: HealthStatus
  /** Machine-stable token; never a response body or a free-text description. */
  readonly reason: string | null
  /** Signal names that produced this verdict, for `/health` traceability. */
  readonly sources: readonly string[]
  /** Newest observation folded into this verdict, UTC ISO 8601. */
  readonly observedAtUtc: string | null
  /**
   * How long this family has been `unknown`, measured on the monotonic clock.
   * `null` while the family is observable. A *required* family that stays
   * unobservable is escalated to `degraded` by the aggregator — an encoder that
   * cannot be reached at all is not "fine, just quiet" (spec §9.2 `degraded`).
   */
  readonly unknownForMs: number | null
  /** True when the escalation above has been applied to `status`. */
  readonly unobservableEscalated: boolean
}

export interface HealthAggregate {
  /** Absolute instant of this evaluation (spec §10.2). */
  readonly atUtc: string
  readonly atMonotonicMs: number
  readonly families: Readonly<Record<HealthFamily, FamilyVerdict>>
  readonly degradedFamilies: readonly HealthFamily[]
  readonly unknownFamilies: readonly HealthFamily[]
  /**
   * Signal names no family claims. Empty in practice — `signals.test.ts` pins
   * the map to every name the producers export — and reported rather than
   * dropped so a new producer cannot become an invisible hole in §9.4 coverage.
   */
  readonly unmappedSignals: readonly string[]
  /**
   * Whether the input path (chat transport + moderation control) is healthy
   * enough to keep the CTA on. Spec §9.2 and §12.3: an unhealthy input or
   * moderation control turns interaction off *before* anything else.
   */
  readonly inputHealthy: boolean
}

/** Components with exactly one restart supervisor each (spec §10.2). */
export const SUPERVISED_COMPONENTS = [
  'engine',
  'chat-source',
  'obs-connection',
  'obs-stream',
  'renderer-source',
  'obs-process',
] as const

export type SupervisedComponent = (typeof SUPERVISED_COMPONENTS)[number]

/**
 * Why the run stopped without restarting itself (spec §9.1, §9.2, §12.3). Every
 * one of these is a human decision to re-enter; the supervisor never leaves
 * `safe_stopped` on its own.
 */
export type SafeStopKind =
  /** A human pulled one of the three kill-switch paths. */
  | 'kill_switch'
  /** Rights, policy or terms problem (spec §9.1). */
  | 'rights_or_policy'
  /** Persisted state cannot be trusted (spec §11 안전 정지). */
  | 'data_integrity'
  /** Account suspension, strike, or a consent that has to be renewed (§9.1). */
  | 'account_action'
  /** Moderation display filter or block control is unhealthy (spec §12.3). */
  | 'moderation_unhealthy'
  /** A component's restart supervisor ran out of attempts (spec §9.2). */
  | 'restart_budget_exhausted'

export interface SafeStopTrigger {
  readonly kind: SafeStopKind
  readonly at: string
  /** Machine-stable reason token. */
  readonly reason: string
  readonly detail: Readonly<Record<string, HealthDetailValue>>
}

/** `/health` summary of the state machine (TASK_SPECS §T12 범위). */
export interface SupervisorHealthSummary {
  readonly state: SupervisorState
  readonly since: string
  readonly lastTransitionReason: string
  readonly safeStop: SafeStopTrigger | null
  readonly interactionEnabled: boolean
  readonly families: readonly (FamilyVerdict & { readonly specItem: number })[]
  readonly components: readonly ComponentHealth[]
  readonly preflight: readonly PreflightCheckResult[]
  readonly deadMan: DeadManStatus
}

export interface ComponentHealth {
  readonly component: SupervisedComponent
  /**
   * Who owns the restart loop. `supervisor` means this process's
   * `RestartSupervisor`; anything else names the module that already owns one,
   * which is exactly why the supervisor does *not* add a second (spec §10.2).
   */
  readonly owner: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly exhausted: boolean
  readonly inFlight: boolean
  readonly lastAttemptAt: string | null
  readonly lastError: string | null
}

/** Spec §9.2 `starting`: 자격·비밀정보·상태·API·렌더러·인코더 사전 점검. */
export const PREFLIGHT_CHECKS = [
  'credentials',
  'secrets',
  'state',
  'api',
  'renderer',
  'encoder',
] as const

export type PreflightCheck = (typeof PREFLIGHT_CHECKS)[number]

export interface PreflightCheckResult {
  readonly check: PreflightCheck
  readonly passed: boolean
  readonly reason: string | null
  readonly at: string
  /**
   * Set when the failure is a rights/policy/account/integrity condition rather
   * than something a retry could fix: the supervisor goes to `safe_stopped`
   * instead of retrying `starting` (spec §9.1).
   */
  readonly safeStop: SafeStopKind | null
}

export interface PreflightResult {
  readonly passed: boolean
  readonly at: string
  readonly checks: readonly PreflightCheckResult[]
  readonly failed: readonly PreflightCheck[]
  readonly safeStop: SafeStopTrigger | null
}

export interface DeadManStatus {
  readonly enabled: boolean
  readonly lastPushAt: string | null
  readonly lastPushOk: boolean | null
  readonly consecutiveFailures: number
  readonly lastError: string | null
}
