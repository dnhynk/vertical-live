import { systemClock } from '@vl/server'
import type { Alert } from '@vl/server/supervisor'
import { fetchMetrics, VirtualClock } from '@vl/simulator'

import { loadSoakConfig, type SoakConfig, type SoakMode, type SoakRunShape } from '../config.js'
import { SoakSystem, soakSupervisorConfig } from '../system.js'
import {
  buildSoakReport,
  type SoakCounters,
  type SoakInterruption,
  type SoakReport,
} from './report.js'

/**
 * The soak harness of TASK_SPECS §T15.
 *
 * Two clock modes, and the difference is the whole point:
 *
 * - **accelerated** (`--mode accelerated`, what CI runs): the injected
 *   `VirtualClock` is moved forward slice by slice, so 72 hours of scenario time
 *   costs a loop rather than 72 hours. Every duration in the report is then
 *   *scenario* time, which the report says in words instead of presenting virtual
 *   milliseconds as latency;
 * - **realtime** (`--mode realtime`, run on the broadcasting host): the system
 *   clock, real waits, real durations. This is the mode spec §11's 72-hour soak
 *   means, and `docs/ops/soak.md` is its procedure.
 *
 * The fault schedule is taken from the fault matrix: only rows whose fixed
 * expectation is `retry` are injected, because a soak measures 무인성 — the run
 * continuing without a human — and a `safe_stopped` row would end it by design.
 * Those rows are covered by `matrix.test.ts` instead.
 */

export interface SoakFault {
  /** Fault matrix row this drill comes from. */
  readonly row: string
  readonly label: string
  readonly apply: (system: SoakSystem) => void
  /** Undone after `holdSlices`; a fault the system heals itself needs no undo. */
  readonly clear?: (system: SoakSystem) => void
  readonly holdSlices: number
  /**
   * Skip the synthetic load while this fault is held.
   *
   * Only `F-11` sets it, and for a defect this task found rather than for
   * convenience: `POST /ingest/simulator` answers **nothing** when the inbox
   * write throws — `SimulatorIngestEndpoint.handle` is called inside a `.then()`
   * and a `SQLITE_BUSY` from `commitIngestBatch` becomes an unhandled rejection
   * with the request still open (`apps/server/src/server.ts`). Posting into a
   * held write lock therefore hangs the caller. The soak does not paper over it:
   * it is written up in the ticket's Follow-ups, `inject()` has a deadline so a
   * soak can never be stopped by it, and the row itself is still drilled — with
   * the lock and without the endpoint — in `matrix.test.ts`.
   */
  readonly skipsInjection?: boolean
}

/** Recoverable rows only (see the module comment). */
export const RECOVERABLE_FAULTS: readonly SoakFault[] = Object.freeze([
  {
    row: 'F-07',
    label: 'rtmps_cut',
    apply: (system) => {
      system.obs.cutRtmps()
    },
    clear: (system) => {
      system.obs.clearFault()
    },
    holdSlices: 3,
  },
  {
    row: 'F-06',
    label: 'dns_outage',
    apply: (system) => {
      system.chat.fail({ errorCode: 'ENOTFOUND', polls: 3 })
    },
    holdSlices: 4,
  },
  {
    row: 'F-13',
    label: 'webgl_context_loss',
    apply: (system) => {
      system.renderer.loseWebglContext()
    },
    clear: (system) => {
      system.renderer.restoreWebglContext()
    },
    holdSlices: 3,
  },
  {
    row: 'F-04',
    label: 'api_rate_limited',
    apply: (system) => {
      system.chat.fail({ httpStatus: 429, reason: 'rateLimitExceeded', polls: 3 })
    },
    holdSlices: 4,
  },
  {
    row: 'F-11',
    label: 'db_write_lock',
    apply: (system) => {
      system.holdWriteLock()
    },
    clear: (system) => {
      system.releaseWriteLock()
    },
    holdSlices: 2,
    skipsInjection: true,
  },
  {
    row: 'F-08',
    label: 'obs_process_crash',
    apply: (system) => {
      system.obs.crashProcess()
    },
    clear: (system) => {
      system.obs.clearFault()
    },
    holdSlices: 4,
  },
])

export interface RunSoakOptions {
  readonly mode: SoakMode
  readonly config?: SoakConfig
  /** Overrides the configured shape, e.g. a shorter run for a unit test. */
  readonly shape?: Partial<SoakRunShape>
  readonly faults?: readonly SoakFault[]
  readonly onLog?: (line: string) => void
  /** Emitted every slice; the CLI turns it into a progress line. */
  readonly onProgress?: (progress: SoakProgress) => void
  /** Flattens the restart backoff so a slice-sized run is not spent waiting. */
  readonly restartDelayMs?: number
}

export interface SoakProgress {
  readonly scenarioMs: number
  readonly durationMs: number
  readonly state: string
  readonly interruptions: number
}

export class SoakConfigurationError extends Error {
  constructor(message: string) {
    super(`soak configuration: ${message}`)
    this.name = 'SoakConfigurationError'
  }
}

export async function runSoak(options: RunSoakOptions): Promise<SoakReport> {
  const config = options.config ?? loadSoakConfig()
  const shape: SoakRunShape = {
    ...(options.mode === 'accelerated' ? config.accelerated : config.realtime),
    ...options.shape,
  }
  const supervisorConfig = soakSupervisorConfig(options.restartDelayMs)
  if (shape.sliceMs > supervisorConfig.coordinatorHeartbeatTimeoutMs) {
    // §9.4(1): an evaluation later than this after the previous one *is* a
    // stalled coordinator. A soak that stepped that coarsely would report a
    // permanently degraded run and prove nothing about the system.
    throw new SoakConfigurationError(
      `sliceMs (${String(shape.sliceMs)}) must not exceed supervisor.coordinatorHeartbeatTimeoutMs (${String(supervisorConfig.coordinatorHeartbeatTimeoutMs)})`,
    )
  }

  const log = options.onLog ?? (() => {})
  const faults = options.faults ?? RECOVERABLE_FAULTS
  const virtualClock = options.mode === 'accelerated' ? new VirtualClock() : undefined
  const startedAt = Date.now()

  const system = await SoakSystem.start({
    clock: virtualClock ?? systemClock,
    ...(virtualClock === undefined ? {} : { virtualClock }),
    supervisorConfig,
    // The soak measures unattended recovery, so the OBS relaunch T17 owns is
    // present. Its absence is fault matrix row F-09, not a soak.
    obsRelauncher: true,
  })

  const interruptions: SoakInterruption[] = []
  const faultsInjected: string[] = []
  let scenarioMs = 0
  let slices = 0
  let liveSlices = 0
  let interactionSlices = 0
  let recoveries = 0
  let freezeEvents = 0
  let freezeEventsDuringInjection = 0
  let envelopesPosted = 0
  let envelopesInserted = 0
  let injectionRefusals = 0
  let safeStops = 0
  let previousState = 'offline'
  let previousStateRevision = 0
  let previousFrameCounter = 0
  let nextInjectionAtMs = 0
  let nextFaultAtMs = shape.faultIntervalMs
  let faultIndex = 0
  let activeFault: { fault: SoakFault; slicesLeft: number } | null = null

  try {
    await system.bringUp(shape.sliceMs)
    previousState = system.supervisor.state
    previousStateRevision = system.observe().stateRevision
    previousFrameCounter = system.observe().rendererFrameCounter
    log(`soak up: state=${previousState}`)

    while (scenarioMs < shape.durationMs) {
      await system.tick(shape.sliceMs)
      scenarioMs += shape.sliceMs
      slices += 1

      const observation = system.observe()
      if (observation.state === 'live') liveSlices += 1
      if (observation.interactionEnabled) interactionSlices += 1
      if (observation.safeStopKind !== null && previousState !== 'safe_stopped') safeStops += 1

      // A freeze is a frame counter standing still while the world moved on. It
      // is never decided from a picture (spec §9.4).
      if (
        observation.stateRevision > previousStateRevision &&
        observation.rendererFrameCounter === previousFrameCounter
      ) {
        freezeEvents += 1
        if (activeFault !== null) freezeEventsDuringInjection += 1
      }
      previousStateRevision = observation.stateRevision
      previousFrameCounter = observation.rendererFrameCounter

      if (previousState === 'live' && observation.state !== 'live') {
        interruptions.push({
          atScenarioMs: scenarioMs,
          state: observation.state,
          reason: system.supervisor.health().lastTransitionReason,
          recoveredAtScenarioMs: null,
          durationMs: null,
        })
      } else if (previousState !== 'live' && observation.state === 'live') {
        const open = interruptions.at(-1)
        if (open !== undefined && open.recoveredAtScenarioMs === null) {
          interruptions[interruptions.length - 1] = {
            ...open,
            recoveredAtScenarioMs: scenarioMs,
            durationMs: scenarioMs - open.atScenarioMs,
          }
          recoveries += 1
        }
      }
      previousState = observation.state

      if (scenarioMs >= nextInjectionAtMs && activeFault?.fault.skipsInjection !== true) {
        nextInjectionAtMs = scenarioMs + shape.injectIntervalMs
        const before = system.postedEnvelopes
        const inserted = await system.inject(shape.commandsPerInjection)
        const posted = system.postedEnvelopes - before
        envelopesPosted += posted
        envelopesInserted += inserted
        if (inserted < posted) injectionRefusals += posted - inserted
      }

      if (activeFault !== null) {
        activeFault.slicesLeft -= 1
        if (activeFault.slicesLeft <= 0) {
          activeFault.fault.clear?.(system)
          log(`fault cleared at ${String(scenarioMs)}ms: ${activeFault.fault.label}`)
          activeFault = null
        }
      } else if (faults.length > 0 && scenarioMs >= nextFaultAtMs) {
        nextFaultAtMs = scenarioMs + shape.faultIntervalMs
        const fault = faults[faultIndex % faults.length] as SoakFault
        faultIndex += 1
        fault.apply(system)
        activeFault = { fault, slicesLeft: fault.holdSlices }
        faultsInjected.push(`${fault.row}:${fault.label}`)
        log(`fault injected at ${String(scenarioMs)}ms: ${fault.row} ${fault.label}`)
      }

      options.onProgress?.({
        scenarioMs,
        durationMs: shape.durationMs,
        state: observation.state,
        interruptions: interruptions.length,
      })
    }

    // Let anything the last fault left behind settle before the report is taken:
    // a run whose final slice was mid-recovery would report an interruption that
    // never recovered when it simply had not been given a pass to recover in.
    activeFault?.fault.clear?.(system)
    activeFault = null
    for (
      let settle = 0;
      settle < SETTLE_SLICES && system.supervisor.state !== 'live';
      settle += 1
    ) {
      await system.tick(shape.sliceMs)
      scenarioMs += shape.sliceMs
    }
    if (previousState !== 'live' && system.supervisor.state === 'live') {
      const open = interruptions.at(-1)
      if (open !== undefined && open.recoveredAtScenarioMs === null) {
        interruptions[interruptions.length - 1] = {
          ...open,
          recoveredAtScenarioMs: scenarioMs,
          durationMs: scenarioMs - open.atScenarioMs,
        }
        recoveries += 1
      }
    }

    const metrics = await fetchMetrics(system.baseUrl)
    const finalObservation = system.observe()
    const counters: SoakCounters = {
      slices,
      liveSlices,
      interactionEnabledSlices: interactionSlices,
      envelopesPosted,
      envelopesInserted,
      injectionRefusals,
      processedIngestSeq: finalObservation.processedIngestSeq,
      stateRevision: finalObservation.stateRevision,
      interruptions: interruptions.length,
      recoveries,
      unrecoveredInterruptions: interruptions.filter(
        (interruption) => interruption.recoveredAtScenarioMs === null,
      ).length,
      freezeEvents,
      freezeEventsDuringInjection,
      backendRestarts: system.backendRestarts,
      // Counted from the attempt alerts, not from `ComponentHealth.attempts`:
      // that counter is the *current* budget and `noteHealthy()` returns it once
      // the component is well again, so a healthy end state would report zero
      // restarts for a run full of them.
      componentRestarts: countRestartAttempts(system.alerts.alerts),
      faultsInjected,
      alerts: countAlerts(system.alerts.alerts.map((alert) => alert.kind)),
      safeStops,
      finalConsecutiveWriterFailures: finalObservation.consecutiveWriterFailures,
    }

    const outages = interruptions.map((interruption) =>
      interruption.durationMs === null
        ? shape.durationMs - interruption.atScenarioMs
        : interruption.durationMs,
    )
    const recovered = interruptions
      .map((interruption) => interruption.durationMs)
      .filter((duration): duration is number => duration !== null)

    log(
      `soak done: freezeEvents=${String(freezeEvents)} (during an injected drill: ${String(freezeEventsDuringInjection)})`,
    )

    return buildSoakReport({
      generatedAt: systemClock.nowUtcIso(),
      mode: options.mode,
      scenarioMs,
      wallClockMs: Date.now() - startedAt,
      finalState: finalObservation.state,
      counters,
      interruptions,
      latency: {
        receivedToCommittedP95Ms: metrics.latencyMs.receivedToCommitted.p95Ms,
        committedToPublishedP95Ms: metrics.latencyMs.committedToPublished.p95Ms,
        publishedToAckedP95Ms: metrics.latencyMs.publishedToAcked.p95Ms,
        endToEndP95Ms: metrics.latencyMs.receivedToAcked.p95Ms,
        samples: metrics.latencyMs.receivedToAcked.count,
      },
      maxContinuousOutageMs: outages.length === 0 ? 0 : Math.max(...outages),
      maxRecoveryMs: recovered.length === 0 ? null : Math.max(...recovered),
      thresholds: config.thresholds,
      provisional: config.provisional,
    })
  } finally {
    await system.close()
  }
}

/** Passes given to a run whose last fault was still clearing when time ran out. */
const SETTLE_SLICES = 12

function countAlerts(kinds: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1
  return counts
}

function countRestartAttempts(alerts: readonly Alert[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const alert of alerts) {
    if (alert.kind !== 'supervisor.restart_attempt') continue
    const component = alert.detail['component']
    if (typeof component !== 'string') continue
    counts[component] = (counts[component] ?? 0) + 1
  }
  return counts
}
