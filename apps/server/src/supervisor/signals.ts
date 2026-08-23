import type { EngineHealth } from '../engine/engine.js'
import type { RendererHealthReport } from '../engine/publisher.js'
import type { HealthSignal, HealthStatus } from '../health/types.js'
import { toMillis } from '../world/time.js'
import {
  OBS_CONGESTION_SIGNAL,
  OBS_FRAMES_SIGNAL,
  OBS_OUTPUT_PROGRESS_SIGNAL,
  OBS_STREAM_SIGNAL,
} from '../obs/health.js'
import {
  YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL,
  YOUTUBE_STREAM_HEALTH_SIGNAL,
  YOUTUBE_STREAM_STATUS_SIGNAL,
} from '../youtube/broadcast/health.js'
import {
  CHAT_KEEPALIVE_SIGNAL,
  CHAT_RECONNECT_SIGNAL,
  CHAT_TRANSPORT_SIGNAL,
  CHAT_USER_EVENTS_SIGNAL,
} from '../youtube/chat/health.js'
import type { SupervisorConfig } from './config.js'
import {
  HEALTH_FAMILIES,
  type DeadManStatus,
  type FamilyVerdict,
  type HealthAggregate,
  type HealthFamily,
} from './types.js'

/**
 * The one aggregator of spec §9.4 (TASK_SPECS §T12: "하나의 집계기로 모아 §9.2
 * 전이를 결정").
 *
 * Two kinds of input meet here:
 *
 * - **pushed** `HealthSignal`s from the producers that already exist (T2 OBS,
 *   T9 chat, T10 broadcast). The aggregator keeps the newest per signal name;
 * - **pulled** readings that have no producer of their own — the engine's
 *   writer state, the renderer's last health frame, the dead-man push result and
 *   the supervisor's own tick — which are turned into signals here so that all
 *   eight families are built the same way and appear the same way on `/health`.
 *
 * The aggregator answers "what do the reports say"; `transitions.ts` answers
 * "what does that mean". Nothing else in the process decides either.
 */

/** Signal name → family (spec §9.4 items 3, 5, 6, 7). */
const PUSHED_SIGNAL_FAMILY: Readonly<Record<string, HealthFamily>> = Object.freeze({
  [CHAT_TRANSPORT_SIGNAL]: 'chat_transport',
  [CHAT_KEEPALIVE_SIGNAL]: 'chat_transport',
  [CHAT_RECONNECT_SIGNAL]: 'chat_transport',
  [CHAT_USER_EVENTS_SIGNAL]: 'chat_transport',
  [OBS_STREAM_SIGNAL]: 'obs_output',
  [OBS_OUTPUT_PROGRESS_SIGNAL]: 'obs_output',
  [OBS_FRAMES_SIGNAL]: 'frame_loss',
  [OBS_CONGESTION_SIGNAL]: 'frame_loss',
  [YOUTUBE_STREAM_STATUS_SIGNAL]: 'youtube_broadcast',
  [YOUTUBE_STREAM_HEALTH_SIGNAL]: 'youtube_broadcast',
  [YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL]: 'youtube_broadcast',
})

/**
 * Which of a family's signals can prove it is *working* (review round 2).
 *
 * The distinction exists because two of the chat signals are `ok` by
 * construction: `youtube.chat.user_events` is always `ok` — that is §9.4(3)'s
 * "무수신만으로 degraded 판정하지 않음" — and `youtube.chat.reconnect` is `ok`
 * whenever no resume token has been rejected, including before anything has ever
 * connected. An idle source reports exactly that: `transport=unknown:not_started`,
 * `keepalive=unknown:no_grpc_channel`, `reconnect=ok`, `user_events=ok`. Folding
 * those together with "any `ok` wins" made a listener that had never connected
 * look like a healthy one, which is what round 2 found.
 *
 * So `chat_transport` may only be lifted to `ok` by the transport signal itself
 * — `youtube.chat.transport` is `ok` exactly when a path is *up*: a gRPC channel
 * the library reports `READY` with no failure streak on it, or a REST poller
 * whose polls are answering (T28 — waiting for a first message is not a fault,
 * because §2.1's world runs with zero viewers). `keepalive` stays outside this
 * set on purpose: a gRPC channel that is still dialling reports `ok` there
 * before there is any connection at all. It can still *degrade* the family
 * (`channel_transient_failure`), because degradation is decided before
 * readiness.
 *
 * Every other family lists all of its signals: each of those producers only
 * reports `ok` when it has observed the thing working.
 */
const FAMILY_READINESS_SIGNALS: Readonly<Record<HealthFamily, readonly string[]>> = Object.freeze({
  coordinator: ['supervisor.coordinator'],
  state_commit: ['engine.state_commit'],
  chat_transport: [CHAT_TRANSPORT_SIGNAL],
  renderer: ['renderer.health'],
  obs_output: [OBS_STREAM_SIGNAL, OBS_OUTPUT_PROGRESS_SIGNAL],
  youtube_broadcast: [
    YOUTUBE_STREAM_STATUS_SIGNAL,
    YOUTUBE_STREAM_HEALTH_SIGNAL,
    YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL,
  ],
  frame_loss: [OBS_FRAMES_SIGNAL, OBS_CONGESTION_SIGNAL],
  dead_man: ['supervisor.dead_man'],
})

function isReadinessSignal(family: HealthFamily, name: string): boolean {
  return FAMILY_READINESS_SIGNALS[family].includes(name)
}

export const SUPERVISOR_COORDINATOR_SIGNAL = 'supervisor.coordinator'
export const ENGINE_STATE_COMMIT_SIGNAL = 'engine.state_commit'
export const RENDERER_HEALTH_SIGNAL = 'renderer.health'
export const DEAD_MAN_SIGNAL = 'supervisor.dead_man'

/** Moderation control health (spec §12.3). Reported, like every other input. */
export interface ModerationHealth {
  readonly status: HealthStatus
  readonly reason: string | null
}

export const MODERATION_HEALTHY: ModerationHealth = Object.freeze({
  status: 'ok' as const,
  reason: null,
})

export interface AggregatorReadings {
  readonly engine: EngineHealth
  readonly renderer: RendererHealthReport | null
  readonly deadMan: DeadManStatus
  readonly moderation: ModerationHealth
  /** Monotonic reading of the previous supervisor evaluation; null on the first. */
  readonly lastEvaluationMonotonicMs: number | null
  readonly nowUtc: string
  readonly nowMonotonicMs: number
}

export class HealthAggregator {
  readonly #config: SupervisorConfig
  readonly #signals = new Map<string, HealthSignal>()
  readonly #unmapped = new Set<string>()
  /** Monotonic instant each family last stopped being observable. */
  readonly #unknownSince = new Map<HealthFamily, number>()

  constructor(config: SupervisorConfig) {
    this.#config = config
  }

  /** Sink for every producer (`HealthSignalSink`). Keeps the newest per name. */
  readonly report = (signal: HealthSignal): void => {
    if (PUSHED_SIGNAL_FAMILY[signal.name] === undefined) {
      // Not dropped in silence: an unmapped producer would otherwise be an
      // invisible hole in §9.4 coverage. `signals.test.ts` pins the mapping to
      // the producers' exported names so this stays empty in practice.
      this.#unmapped.add(signal.name)
      return
    }
    this.#signals.set(signal.name, signal)
  }

  /** Newest signal per name, for `/health` and diagnostics. */
  signals(): readonly HealthSignal[] {
    return [...this.#signals.values()]
  }

  evaluate(readings: AggregatorReadings): HealthAggregate {
    const derived = deriveSignals(readings, this.#config)
    const byFamily = new Map<HealthFamily, HealthSignal[]>()
    for (const family of HEALTH_FAMILIES) byFamily.set(family, [])

    for (const signal of this.#signals.values()) {
      const family = PUSHED_SIGNAL_FAMILY[signal.name]
      if (family === undefined) continue
      // A report nobody refreshed is not an observation any more.
      if (
        readings.nowMonotonicMs - signal.observedAtMonotonicMs >
        this.#config.signalStaleAfterMs
      ) {
        continue
      }
      byFamily.get(family)?.push(signal)
    }
    for (const [family, signal] of derived) byFamily.get(family)?.push(signal)

    const families = {} as Record<HealthFamily, FamilyVerdict>
    const degradedFamilies: HealthFamily[] = []
    const unknownFamilies: HealthFamily[] = []
    const requiredNotOk: HealthFamily[] = []

    for (const family of HEALTH_FAMILIES) {
      const verdict = this.#verdict(family, byFamily.get(family) ?? [], readings)
      families[family] = verdict
      if (verdict.status === 'degraded') degradedFamilies.push(family)
      else if (verdict.status === 'unknown') unknownFamilies.push(family)
      if (verdict.status !== 'ok' && this.#config.requiredFamilies.includes(family)) {
        requiredNotOk.push(family)
      }
    }

    return {
      atUtc: readings.nowUtc,
      atMonotonicMs: readings.nowMonotonicMs,
      families: Object.freeze(families),
      degradedFamilies,
      unknownFamilies,
      requiredNotOk,
      unmappedSignals: [...this.#unmapped],
      // Spec §9.2 and §12.3: an unhealthy input path or moderation control turns
      // the CTA off first.
      //
      // The distinction that matters (review round 1, B2): a chat *nobody is
      // typing in* still reports — T9 emits `youtube.chat.user_events=ok`
      // throughout the silence — and that is the §9.4(3) case where silence must
      // not count as a fault. A chat transport that reports **nothing at all** is
      // a producer that is not there, which is not evidence of health. So the CTA
      // needs a positive `ok`, not merely the absence of `degraded`.
      inputHealthy: families.chat_transport.status === 'ok' && readings.moderation.status === 'ok',
    }
  }

  #verdict(
    family: HealthFamily,
    signals: readonly HealthSignal[],
    readings: AggregatorReadings,
  ): FamilyVerdict {
    const degraded = signals.filter((signal) => signal.status === 'degraded')
    const ok = signals.filter((signal) => signal.status === 'ok')
    const unknown = signals.filter((signal) => signal.status === 'unknown')

    const observedAtUtc = newestObservation(signals)
    const sources = signals.map((signal) => signal.name)

    if (degraded.length > 0) {
      this.#unknownSince.delete(family)
      return {
        family,
        status: 'degraded',
        reason: degraded[0]?.reason ?? 'degraded',
        sources: degraded.map((signal) => signal.name),
        observedAtUtc,
        unknownForMs: null,
        unobservableEscalated: false,
      }
    }

    // Only a *readiness* signal can say a family is healthy (review round 2).
    // The rest of a family's signals describe what has happened to it; they can
    // degrade it, and they add detail, but they are not evidence that it works.
    if (ok.some((signal) => isReadinessSignal(family, signal.name))) {
      this.#unknownSince.delete(family)
      return {
        family,
        status: 'ok',
        reason: null,
        sources,
        observedAtUtc,
        unknownForMs: null,
        unobservableEscalated: false,
      }
    }

    // Nothing observable — or nothing that *proves* readiness. How long that has
    // been true decides whether it is a fault: a producer that has never been
    // reachable for a required family is not "quiet", it is an encoder or an API
    // this run cannot see (spec §9.2).
    const since = this.#unknownSince.get(family) ?? readings.nowMonotonicMs
    this.#unknownSince.set(family, since)
    const unknownForMs = readings.nowMonotonicMs - since
    const required = this.#config.requiredFamilies.includes(family)
    const escalate = required && unknownForMs >= this.#config.unobservableGraceMs
    const notReady = unknown.find((signal) => isReadinessSignal(family, signal.name))
    const reason = notReady?.reason ?? unknown[0]?.reason ?? 'no_observation'

    return {
      family,
      status: escalate ? 'degraded' : 'unknown',
      reason: escalate ? `unobservable:${reason}` : reason,
      sources,
      observedAtUtc,
      unknownForMs,
      unobservableEscalated: escalate,
    }
  }
}

/** Families with no producer of their own (spec §9.4(1)(2)(4)(8)). */
function deriveSignals(
  readings: AggregatorReadings,
  config: SupervisorConfig,
): readonly (readonly [HealthFamily, HealthSignal])[] {
  return [
    ['coordinator', coordinatorSignal(readings, config)],
    ['state_commit', stateCommitSignal(readings, config)],
    ['renderer', rendererSignal(readings, config)],
    ['dead_man', deadManSignal(readings)],
  ] as const
}

/**
 * §9.4(1) coordinator heartbeat. Two things make it: the supervisor's own loop
 * still running on schedule, and the single writer still able to finish a pass —
 * a wedged writer is a coordinator that is alive but not coordinating.
 */
function coordinatorSignal(readings: AggregatorReadings, config: SupervisorConfig): HealthSignal {
  const sinceLastEvaluationMs =
    readings.lastEvaluationMonotonicMs === null
      ? null
      : readings.nowMonotonicMs - readings.lastEvaluationMonotonicMs
  const detail = {
    ready: readings.engine.ready,
    consecutiveWriterFailures: readings.engine.consecutiveFailures,
    lastWriterFailureAt: readings.engine.lastFailure?.at ?? null,
    sinceLastEvaluationMs,
  }
  if (readings.engine.consecutiveFailures > 0) {
    return signal(SUPERVISOR_COORDINATOR_SIGNAL, 'supervisor', readings, {
      status: 'degraded',
      reason: 'writer_failing',
      detail,
    })
  }
  if (
    sinceLastEvaluationMs !== null &&
    sinceLastEvaluationMs > config.coordinatorHeartbeatTimeoutMs
  ) {
    return signal(SUPERVISOR_COORDINATOR_SIGNAL, 'supervisor', readings, {
      status: 'degraded',
      reason: 'evaluation_stalled',
      detail,
    })
  }
  if (!readings.engine.ready) {
    return signal(SUPERVISOR_COORDINATOR_SIGNAL, 'supervisor', readings, {
      status: 'unknown',
      reason: 'engine_not_ready',
      detail,
    })
  }
  return signal(SUPERVISOR_COORDINATOR_SIGNAL, 'supervisor', readings, { status: 'ok', detail })
}

/** §9.4(2) time of the last committed state transition. */
function stateCommitSignal(readings: AggregatorReadings, config: SupervisorConfig): HealthSignal {
  const lastCommittedAt = readings.engine.lastCommittedAt
  const ageMs =
    lastCommittedAt === null ? null : toMillis(readings.nowUtc) - toMillis(lastCommittedAt)
  const detail = {
    lastCommittedAt,
    ageMs,
    stateRevision: readings.engine.stateRevision,
    processedIngestSeq: readings.engine.processedIngestSeq,
  }
  if (lastCommittedAt === null) {
    return signal(ENGINE_STATE_COMMIT_SIGNAL, 'engine', readings, {
      status: 'unknown',
      reason: 'no_commit_yet',
      detail,
    })
  }
  if (ageMs !== null && ageMs > config.stateCommitStaleAfterMs) {
    return signal(ENGINE_STATE_COMMIT_SIGNAL, 'engine', readings, {
      status: 'degraded',
      reason: 'state_commit_stale',
      detail,
    })
  }
  return signal(ENGINE_STATE_COMMIT_SIGNAL, 'engine', readings, { status: 'ok', detail })
}

/**
 * §9.4(4) renderer heartbeat, frame counter, applied/acked `stateRevision`, FPS
 * and WebGL context. The engine already publishes the ACK-staleness verdict it
 * owns (`renderer_ack_stale`, `no_renderer`), so this reuses it rather than
 * re-deriving a second, differently-timed answer to the same question.
 */
function rendererSignal(readings: AggregatorReadings, config: SupervisorConfig): HealthSignal {
  const report = readings.renderer
  const reportAgeMs =
    report === null ? null : toMillis(readings.nowUtc) - toMillis(report.observedAtUtc)
  const detail = {
    rendererCount: readings.engine.rendererCount,
    frameCounter: report?.frameCounter ?? null,
    fps: report?.fps ?? null,
    webglContextLost: report?.webglContextLost ?? null,
    lastAppliedStateRevision: report?.lastAppliedStateRevision ?? null,
    lastAckedStateRevision: readings.engine.lastAckedStateRevision,
    stateRevision: readings.engine.stateRevision,
    reportAgeMs,
  }

  const engineReason = readings.engine.degradedReasons.find(
    (reason) => reason === 'no_renderer' || reason === 'renderer_ack_stale',
  )
  if (engineReason !== undefined) {
    return signal(RENDERER_HEALTH_SIGNAL, 'renderer', readings, {
      status: 'degraded',
      reason: engineReason,
      detail,
    })
  }
  if (report === null) {
    return signal(RENDERER_HEALTH_SIGNAL, 'renderer', readings, {
      status: 'unknown',
      reason: 'no_health_frame',
      detail,
    })
  }
  if (report.webglContextLost) {
    return signal(RENDERER_HEALTH_SIGNAL, 'renderer', readings, {
      status: 'degraded',
      reason: 'webgl_context_lost',
      detail,
    })
  }
  if (reportAgeMs !== null && reportAgeMs > config.renderer.reportStaleAfterMs) {
    return signal(RENDERER_HEALTH_SIGNAL, 'renderer', readings, {
      status: 'degraded',
      reason: 'renderer_heartbeat_stale',
      detail,
    })
  }
  if (report.fps < config.renderer.minFps) {
    return signal(RENDERER_HEALTH_SIGNAL, 'renderer', readings, {
      status: 'degraded',
      reason: 'fps_below_minimum',
      detail,
    })
  }
  return signal(RENDERER_HEALTH_SIGNAL, 'renderer', readings, { status: 'ok', detail })
}

/**
 * §9.4(8) dead-man monitor. A failed push means *this host* could not reach the
 * external monitor; the monitor's own view of the host is off-host by design
 * ([S23]) and is never mirrored here. It is reported, and it never by itself
 * stops a broadcast that is otherwise fine — which is why `dead_man` is not one
 * of the required families in `config/default.json`.
 */
function deadManSignal(readings: AggregatorReadings): HealthSignal {
  const detail = {
    enabled: readings.deadMan.enabled,
    lastPushAt: readings.deadMan.lastPushAt,
    consecutiveFailures: readings.deadMan.consecutiveFailures,
    lastError: readings.deadMan.lastError,
  }
  if (!readings.deadMan.enabled) {
    return signal(DEAD_MAN_SIGNAL, 'supervisor', readings, {
      status: 'unknown',
      reason: 'dead_man_disabled',
      detail,
    })
  }
  if (readings.deadMan.lastPushOk === null) {
    return signal(DEAD_MAN_SIGNAL, 'supervisor', readings, {
      status: 'unknown',
      reason: 'no_push_yet',
      detail,
    })
  }
  if (!readings.deadMan.lastPushOk) {
    return signal(DEAD_MAN_SIGNAL, 'supervisor', readings, {
      status: 'degraded',
      reason: 'push_failed',
      detail,
    })
  }
  return signal(DEAD_MAN_SIGNAL, 'supervisor', readings, { status: 'ok', detail })
}

interface SignalBody {
  readonly status: HealthStatus
  readonly reason?: string
  readonly detail: HealthSignal['detail']
}

function signal(
  name: string,
  component: HealthSignal['component'],
  readings: AggregatorReadings,
  body: SignalBody,
): HealthSignal {
  return {
    component,
    name,
    status: body.status,
    observedAtUtc: readings.nowUtc,
    observedAtMonotonicMs: readings.nowMonotonicMs,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
    detail: body.detail,
  }
}

function newestObservation(signals: readonly HealthSignal[]): string | null {
  let newest: string | null = null
  for (const signal of signals) {
    if (newest === null || toMillis(signal.observedAtUtc) > toMillis(newest)) {
      newest = signal.observedAtUtc
    }
  }
  return newest
}
