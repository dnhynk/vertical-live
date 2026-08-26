import type { EngineHealth, InputHealth } from '../../engine/engine.js'
import type { RendererHealthReport } from '../../engine/publisher.js'
import type { HealthSignal } from '../../health/types.js'
import type { CommandMetricsSnapshot } from '../../input/metrics.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { RecordingAlertSink, type AlertSink } from '../alerts.js'
import { loadSupervisorConfig, type SupervisorConfig } from '../config.js'
import type { DeadManMonitor } from '../deadman.js'
import type { DiagnosticScreenshotRecorder } from '../screenshot.js'
import { PREFLIGHT_OK, type PreflightProbes } from '../preflight.js'
import { Supervisor, type ComponentActions } from '../supervisor.js'
import type { StartupSteps } from '../startup.js'

/**
 * Test double for the supervisor's collaborators. Everything is injected — the
 * clock, the engine readings, the restart actions — so a transition test states
 * a signal combination and reads a state, with no timers and no sockets.
 */

export const BASE_ENGINE_HEALTH: EngineHealth = Object.freeze({
  ready: true,
  degraded: false,
  degradedReasons: [],
  interactionEnabled: true,
  stateRevision: 12,
  processedIngestSeq: 40,
  lastCommittedAt: '2026-01-01T00:00:00.000Z',
  openEffectCount: 0,
  rendererCount: 1,
  lastAckedStateRevision: 12,
  inputMode: 'direct',
  broadcastLifecycle: 'live',
  lastFailure: null,
  consecutiveFailures: 0,
  ingestRejected: {
    invalid: { count: 0, byCode: {}, lastCode: null, lastAt: null },
    unsupported: { count: 0, lastAt: null },
  },
})

export const HEALTHY_RENDERER: RendererHealthReport = Object.freeze({
  frameCounter: 900,
  fps: 30,
  webglContextLost: false,
  lastAppliedStateRevision: 12,
  lastAppliedEffectId: null,
  observedAtUtc: '2026-01-01T00:00:00.000Z',
})

export function signal(
  name: string,
  status: HealthSignal['status'],
  options: {
    readonly component?: HealthSignal['component']
    readonly reason?: string
    readonly at?: string
    readonly monotonicMs?: number
  } = {},
): HealthSignal {
  return {
    component: options.component ?? 'obs',
    name,
    status,
    observedAtUtc: options.at ?? '2026-01-01T00:00:00.000Z',
    observedAtMonotonicMs: options.monotonicMs ?? 0,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    detail: {},
  }
}

/** Every §9.4 family reporting `ok`, so a test only states what it changes. */
export function healthySignals(monotonicMs = 0, except: readonly string[] = []): HealthSignal[] {
  const at = new Date(Date.UTC(2026, 0, 1) + monotonicMs).toISOString()
  const make = (
    name: string,
    component: HealthSignal['component'],
    status: HealthSignal['status'] = 'ok',
  ): HealthSignal => signal(name, status, { component, at, monotonicMs })
  return [
    make('obs.stream', 'obs'),
    make('obs.output_progress', 'obs'),
    make('obs.frames', 'obs'),
    make('obs.congestion', 'obs'),
    make('youtube.stream_status', 'youtube'),
    make('youtube.stream_health', 'youtube'),
    make('youtube.broadcast_lifecycle', 'youtube'),
    make('youtube.chat.transport', 'youtube-chat'),
    make('youtube.chat.keepalive', 'youtube-chat'),
    make('youtube.chat.reconnect', 'youtube-chat'),
    make('youtube.chat.user_events', 'youtube-chat'),
  ].filter((item) => !except.includes(item.name))
}

export interface SupervisorHarness {
  readonly clock: FakeClock
  readonly supervisor: Supervisor
  readonly alerts: RecordingAlertSink
  readonly config: SupervisorConfig
  readonly restarts: string[]
  engine: EngineHealth
  renderer: RendererHealthReport | null
  inputHealth: InputHealth
  obsConnectionAttempts: number
  /** Fails the named component's restart action until it is removed. */
  readonly failing: Set<string>
  /**
   * Pushes a fresh set of `ok` signals stamped at the current fake time, minus
   * the names a test wants to keep saying something else.
   */
  pushHealthy(except?: readonly string[]): void
  push(...signals: readonly HealthSignal[]): void
}

export interface HarnessOptions {
  readonly config?: SupervisorConfig
  readonly preflight?: PreflightProbes
  readonly startup?: StartupSteps
  readonly onSafeStop?: () => void
  readonly onHaltOutwardWork?: () => void
  /**
   * Flattens the restart backoff so a test can spend a component's whole budget
   * without advancing the fake clock past the other families' freshness windows.
   */
  readonly restartDelayMs?: number
  /** Real collaborators, so a test can assert they were never started. */
  readonly deadMan?: DeadManMonitor
  readonly screenshots?: DiagnosticScreenshotRecorder
  /**
   * Replaces the recording sink — for a test that needs delivery to *block*,
   * which is where the safe-stop ordering matters (review round 4).
   */
  readonly alerts?: AlertSink
  /** Replaces individual component actions, e.g. with one that can be gated. */
  readonly actions?: Partial<ComponentActions>
  /** The segment swap of BOARD D-21; absent means nothing rolls over. */
  readonly rollSegment?: () => Promise<void>
  /**
   * Input counters for the `filter_evasion_surge` heuristic (§12.3, §T22).
   * Absent by default, which is how every pre-T22 test keeps its behaviour: no
   * sampler means no detector.
   */
  readonly commandMetrics?: () => CommandMetricsSnapshot
}

/** All six pre-checks passing; a test that cares overrides the ones it tests. */
export function passingPreflight(): PreflightProbes {
  return {
    credentials: () => PREFLIGHT_OK,
    secrets: () => PREFLIGHT_OK,
    state: () => PREFLIGHT_OK,
    api: () => PREFLIGHT_OK,
    renderer: () => PREFLIGHT_OK,
    encoder: () => PREFLIGHT_OK,
  }
}

export function createSupervisorHarness(options: HarnessOptions = {}): SupervisorHarness {
  const clock = new FakeClock()
  const alerts = new RecordingAlertSink()
  const loaded = options.config ?? loadSupervisorConfig()
  const config: SupervisorConfig =
    options.restartDelayMs === undefined
      ? loaded
      : {
          ...loaded,
          restart: {
            ...loaded.restart,
            initialDelayMs: options.restartDelayMs,
            maxDelayMs: options.restartDelayMs,
          },
        }
  const restarts: string[] = []
  const failing = new Set<string>()

  // `null` means "use the default reading, stamped at the current fake time", so
  // a test that advances the clock does not accidentally age the renderer frame
  // or the last commit into a fault it did not mean to create.
  const state = {
    engine: null as EngineHealth | null,
    renderer: undefined as RendererHealthReport | null | undefined,
    inputHealth: 'ok' as InputHealth,
    obsConnectionAttempts: 0,
  }
  const engineHealth = (): EngineHealth =>
    state.engine ?? { ...BASE_ENGINE_HEALTH, lastCommittedAt: clock.nowUtcIso() }
  const rendererHealth = (): RendererHealthReport | null =>
    state.renderer === undefined
      ? { ...HEALTHY_RENDERER, observedAtUtc: clock.nowUtcIso() }
      : state.renderer

  const action = (component: string) => async (): Promise<void> => {
    restarts.push(component)
    if (failing.has(component)) throw new Error(`${component} restart failed`)
    await Promise.resolve()
  }

  const actions: ComponentActions = {
    engine: action('engine'),
    chatSource: action('chat-source'),
    obsStream: action('obs-stream'),
    rendererSource: action('renderer-source'),
    obsProcess: action('obs-process'),
    obsConnectionAttempts: () => state.obsConnectionAttempts,
    ...options.actions,
  }

  const supervisor = new Supervisor({
    config,
    clock,
    engine: {
      health: engineHealth,
      reportInputHealth: (health) => {
        state.inputHealth = health
      },
    },
    renderer: rendererHealth,
    alerts: options.alerts ?? alerts,
    actions,
    autoEvaluate: false,
    // Fixed jitter so the backoff delays in a test are the same every run.
    random: () => 0,
    ...(options.preflight === undefined ? {} : { preflight: options.preflight }),
    ...(options.startup === undefined ? {} : { startup: options.startup }),
    ...(options.onSafeStop === undefined ? {} : { onSafeStop: options.onSafeStop }),
    ...(options.onHaltOutwardWork === undefined
      ? {}
      : { onHaltOutwardWork: options.onHaltOutwardWork }),
    ...(options.deadMan === undefined ? {} : { deadMan: options.deadMan }),
    ...(options.screenshots === undefined ? {} : { screenshots: options.screenshots }),
    ...(options.commandMetrics === undefined ? {} : { commandMetrics: options.commandMetrics }),
    ...(options.rollSegment === undefined ? {} : { rollSegment: options.rollSegment }),
  })

  return {
    clock,
    supervisor,
    alerts,
    config,
    restarts,
    failing,
    get engine() {
      return engineHealth()
    },
    set engine(value: EngineHealth) {
      state.engine = value
    },
    get renderer() {
      return rendererHealth()
    },
    set renderer(value: RendererHealthReport | null) {
      state.renderer = value
    },
    get inputHealth() {
      return state.inputHealth
    },
    set inputHealth(value: InputHealth) {
      state.inputHealth = value
    },
    get obsConnectionAttempts() {
      return state.obsConnectionAttempts
    },
    set obsConnectionAttempts(value: number) {
      state.obsConnectionAttempts = value
    },
    pushHealthy(except: readonly string[] = []) {
      for (const item of healthySignals(clock.monotonicMs(), except)) supervisor.report(item)
    },
    push(...signals: readonly HealthSignal[]) {
      for (const item of signals) supervisor.report(item)
    },
  }
}
