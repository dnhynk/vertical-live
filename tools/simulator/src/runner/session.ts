import {
  loadEngineConfig,
  systemClock,
  type EngineMetricsSnapshot,
  type EngineRuntimeConfig,
} from '@vl/server'
import { loadInputConfig, type InputConfig } from '@vl/server/input'

import { planScenario, requiresParser, type Scenario } from '../scenario/index.js'
import { simulatorCommandParser } from './adversarial.js'
import { VirtualClock } from './clock.js'
import { SimulatorHarness } from './harness.js'
import type { InjectTarget } from './inject.js'
import { runScenario, type RunResult } from './run.js'
import { StubRenderer } from './stub-renderer.js'

/**
 * One in-process backend plus one stub renderer, ready to play scenarios.
 *
 * This is what the CLI, the latency report and every replay test open. Keeping
 * the assembly in one place means the CI run and the reported numbers come from
 * the same wiring — an assertion that passed against a differently-built server
 * would not be evidence of anything (spec §11).
 */

export interface SessionOptions {
  /** `virtual` for CI (no real waiting), `system` for the latency report. */
  readonly clock?: 'virtual' | 'system'
  readonly config?: EngineRuntimeConfig
  readonly inputConfig?: InputConfig
  /** Off for scenarios about a renderer that is not there. */
  readonly attachRenderer?: boolean
  /**
   * Off makes the stub renderer receive effects without acknowledging them,
   * which is what leaves an effect open long enough for the engine to retransmit
   * it (spec §7.3(7), §11 유료 무결성 "재전송돼도 재시작하지 않음").
   */
  readonly rendererAckEffects?: boolean
  readonly rendererAckStates?: boolean
  readonly sliceMs?: number
  readonly speed?: number
  readonly onLog?: (line: string) => void
  readonly onAdvance?: (scenarioMs: number) => void
}

export interface SimulatorSession {
  readonly harness: SimulatorHarness
  readonly renderer: StubRenderer | null
  readonly clock: VirtualClock | null
  readonly target: InjectTarget
  run(scenario: Scenario): Promise<RunResult>
  metrics(): EngineMetricsSnapshot
  /**
   * Attaches a stub renderer to a session that was opened without one, which is
   * how a recovery test clears the `no_renderer` degraded condition and lets the
   * recovered backlog drain (spec §9.2, §11 상태 복구).
   */
  attachRenderer(): Promise<StubRenderer>
  /** Restarts the backend and reattaches the renderer (spec §11 상태 복구). */
  restart(): Promise<void>
  close(): Promise<void>
}

export async function openSession(options: SessionOptions = {}): Promise<SimulatorSession> {
  const useVirtual = (options.clock ?? 'virtual') === 'virtual'
  const clock = useVirtual ? new VirtualClock() : null
  const config = options.config ?? loadEngineConfig({ env: {} })
  const inputConfig = options.inputConfig ?? loadInputConfig({ env: {} })
  const harness = new SimulatorHarness({
    clock: clock ?? systemClock,
    config,
    inputConfig,
  })
  await harness.start()

  let renderer: StubRenderer | null = null
  const attach = async (): Promise<StubRenderer> => {
    const attached = new StubRenderer({
      wsUrl: harness.wsUrl,
      token: harness.rendererToken,
      clock: harness.clock,
      ...(options.rendererAckEffects === undefined
        ? {}
        : { ackEffects: options.rendererAckEffects }),
      ...(options.rendererAckStates === undefined ? {} : { ackStates: options.rendererAckStates }),
    })
    await attached.connect()
    renderer = attached
    // The hello of spec §7.3(7) is answered on a writer pass, so the world knows
    // it has a renderer before the first scenario batch arrives.
    harness.engine.pump()
    return attached
  }
  if (options.attachRenderer !== false) await attach()

  const target: InjectTarget = { baseUrl: harness.baseUrl, token: harness.simulatorToken }
  const parseCommand = simulatorCommandParser({ inputConfig })

  return {
    harness,
    // A getter: `attachRenderer()` may bind one after the session was opened.
    get renderer() {
      return renderer
    },
    clock,
    target,
    async run(scenario) {
      const plan = planScenario(scenario, requiresParser(scenario) ? { parseCommand } : {})
      return runScenario({
        plan,
        target,
        ...(clock === null ? {} : { clock }),
        engine: harness.engine,
        ...(renderer === null ? {} : { renderer }),
        ...(options.sliceMs === undefined ? {} : { sliceMs: options.sliceMs }),
        ...(options.speed === undefined ? {} : { speed: options.speed }),
        ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
        ...(options.onAdvance === undefined ? {} : { onAdvance: options.onAdvance }),
      })
    },
    metrics() {
      return harness.engine.metrics()
    },
    attachRenderer: attach,
    async restart() {
      const attached = renderer
      if (attached !== null) await attached.disconnect()
      await harness.restart()
      // A restart drops the socket; a renderer that was attached reconnects and
      // is re-sent the recovery snapshot (spec §7.3(7), §10.2).
      if (attached !== null) await attach()
    },
    async close() {
      if (renderer !== null) await renderer.disconnect()
      await harness.close()
    },
  }
}
