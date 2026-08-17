import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createServer,
  InMemorySecretVault,
  loadEngineConfig,
  PersistenceStore,
  RendererHub,
  SimulatorIngestEndpoint,
  StateEngine,
  type Clock,
  type EngineRuntimeConfig,
  type HealthSignal,
} from '@vl/server'
import { loadInputConfig, type InputConfig } from '@vl/server/input'
import {
  buildPreflightProbes,
  buildStartupSteps,
  loadSupervisorConfig,
  RecordingAlertSink,
  Supervisor,
  type SupervisorConfig,
  type SupervisorHealthSummary,
  type SupervisorState,
} from '@vl/server/supervisor'
import { flushEventLoop, postEnvelopes, type VirtualClock } from '@vl/simulator'

import { soakCommandBatch } from './events.js'
import { FaultyAuth } from './injection/auth.js'
import { FaultyBroadcast } from './injection/broadcast.js'
import { FaultyChat } from './injection/chat.js'
import { FaultyObs } from './injection/obs.js'
import { SoakRenderer } from './injection/renderer.js'
import { captureDiskFullError, withDiskFull, WriteLockHolder, type DiskFullGate } from './injection/storage.js'

/**
 * The whole supervised run in one process, with every collaborator replaceable
 * by a fault.
 *
 * It is assembled in the order `apps/server/src/main.ts` assembles it — store,
 * HTTP surface, renderer hub, engine, OBS, YouTube, supervisor, start-up
 * sequence, pre-checks — and it uses the same `buildStartupSteps` /
 * `buildPreflightProbes` composition, so the sequence under test is the
 * production one. Four things differ, each on purpose:
 *
 * - the clock is injected, so a 72-hour soak costs a loop rather than 72 hours;
 * - `autoTick` is off and `autoEvaluate` is off, so the writer pass and the
 *   supervisor evaluation happen where the harness can see them instead of
 *   interleaving with an assertion;
 * - OBS, the chat source and the broadcast lifecycle are the fault-injectable
 *   adapters of `injection/`, which still produce the production health signals;
 * - the database is a temporary file and every token is generated per system, so
 *   no vault value and no operational database is ever touched (CLAUDE.md §3).
 *
 * Nothing about the *decisions* is faked: the aggregator, the transition table,
 * the restart supervisors, the alert path and the engine are the real ones.
 */

export interface SoakSystemOptions {
  readonly clock: Clock
  /** Present when the clock is virtual: `tick()` advances it. */
  readonly virtualClock?: VirtualClock
  /** An `obs-process` relaunch action exists (T17). Off = today's `main.ts`. */
  readonly obsRelauncher?: boolean
  readonly engineConfig?: EngineRuntimeConfig
  readonly inputConfig?: InputConfig
  readonly supervisorConfig?: SupervisorConfig
  readonly busyTimeoutMs?: number
  /** Flattens the restart backoff so a drill does not wait out real delays. */
  readonly restartDelayMs?: number
}

export const SOAK_BUSY_TIMEOUT_MS = 250

export interface SoakObservation {
  readonly state: SupervisorState
  readonly interactionEnabled: boolean
  readonly degradedFamilies: readonly string[]
  readonly safeStopKind: string | null
  readonly engineReady: boolean
  readonly stateRevision: number
  readonly processedIngestSeq: number
  readonly consecutiveWriterFailures: number
  readonly rendererFrameCounter: number
  readonly webglContextLost: boolean
}

export class SoakSystem {
  readonly clock: Clock
  readonly config: EngineRuntimeConfig
  readonly inputConfig: InputConfig
  readonly supervisorConfig: SupervisorConfig
  readonly directory: string
  readonly file: string
  readonly simulatorToken: string
  readonly rendererToken: string
  readonly alerts = new RecordingAlertSink()

  readonly obs: FaultyObs
  readonly chat: FaultyChat
  readonly broadcast: FaultyBroadcast
  readonly auth: FaultyAuth
  readonly renderer: SoakRenderer

  readonly #virtualClock: VirtualClock | undefined
  readonly #busyTimeoutMs: number
  readonly #supervisor: Supervisor

  #store: PersistenceStore | null = null
  #diskFull: DiskFullGate | null = null
  #engine: StateEngine | null = null
  #hub: RendererHub | null = null
  #http: Server | null = null
  #port = 0
  #lock: WriteLockHolder | null = null
  #diskFullError: unknown = null
  #sequence = 0
  #backendRestarts = 0

  private constructor(options: SoakSystemOptions, auth: FaultyAuth) {
    this.clock = options.clock
    this.#virtualClock = options.virtualClock
    this.config = options.engineConfig ?? loadEngineConfig({ env: {} })
    this.inputConfig = options.inputConfig ?? loadInputConfig({ env: {} })
    this.supervisorConfig = options.supervisorConfig ?? soakSupervisorConfig(options.restartDelayMs)
    this.#busyTimeoutMs = options.busyTimeoutMs ?? SOAK_BUSY_TIMEOUT_MS
    this.directory = mkdtempSync(join(tmpdir(), 'vl-soak-'))
    this.file = join(this.directory, 'vertical-live.db')
    // Obviously synthetic, generated per system, never persisted or printed.
    this.simulatorToken = `soak_sim_token_${randomBytes(16).toString('hex')}`
    this.rendererToken = `soak_renderer_token_${randomBytes(16).toString('hex')}`

    this.auth = auth
    this.obs = new FaultyObs({
      clock: this.clock,
      relauncher: options.obsRelauncher ?? false,
    })
    this.chat = new FaultyChat({
      clock: this.clock,
      onSafeStop: (reason, detail) => {
        void this.#supervisor.requestSafeStop({
          kind: 'rights_or_policy',
          at: this.clock.nowUtcIso(),
          reason,
          detail,
        })
      },
    })
    this.broadcast = new FaultyBroadcast({
      clock: this.clock,
      onSafeStop: (reason, detail) => {
        void this.#supervisor.requestSafeStop({
          kind: 'rights_or_policy',
          at: this.clock.nowUtcIso(),
          reason,
          detail,
        })
      },
    })
    this.renderer = new SoakRenderer({
      token: this.rendererToken,
      clock: this.clock,
    })

    const secrets = new InMemorySecretVault({
      'server.rendererToken': this.rendererToken,
      'server.adminToken': `soak_admin_token_${randomBytes(16).toString('hex')}`,
      'server.simulatorToken': this.simulatorToken,
      'youtube.streamKey': 'soak-synthetic-stream-key',
    })

    // A backend restart replaces the engine, so every port reads it through a
    // closure rather than capturing the instance that exists right now.
    const engineReady = (): boolean => this.#engine?.ready ?? false
    const runtimeDeps = {
      config: this.supervisorConfig,
      clock: this.clock,
      engine: {
        start: () => {
          this.engine.start()
        },
        get ready(): boolean {
          return engineReady()
        },
        health: () => this.engine.health(),
      },
      openStore: () => {
        this.store.assertReady()
      },
      retention: null,
      broadcast: this.broadcast.port,
      obs: this.obs.port,
      chat: this.chat.port,
    }

    this.#supervisor = new Supervisor({
      config: this.supervisorConfig,
      clock: this.clock,
      engine: {
        health: () => this.engine.health(),
        reportInputHealth: (health) => {
          this.engine.reportInputHealth(health)
        },
      },
      renderer: () => this.hub.lastHealth,
      sources: () => this.chat.signals(),
      alerts: this.alerts,
      autoEvaluate: false,
      // Fixed jitter: a soak has to be reproducible (spec §10.2 시드 주입).
      random: () => 0,
      startup: buildStartupSteps(runtimeDeps),
      preflight: buildPreflightProbes({ ...runtimeDeps, secrets }),
      actions: {
        engine: () => {
          this.engine.stop()
          this.engine.start()
          return Promise.resolve()
        },
        chatSource: this.chat.restart,
        obsStream: this.obs.restartStream,
        rendererSource: this.renderer.reload,
        obsProcess: this.obs.relaunchProcess,
        obsConnectionAttempts: () => this.obs.reconnectAttempts,
      },
    })
  }

  static async start(options: SoakSystemOptions): Promise<SoakSystem> {
    const supervisorRef: { current: Supervisor | null } = { current: null }
    const auth = await FaultyAuth.start({
      clock: options.clock,
      events: {
        emit: (event) => {
          supervisorRef.current?.onAuthEvent(event)
        },
      },
    })
    const system = new SoakSystem(options, auth)
    supervisorRef.current = system.supervisor
    await system.#boot()
    return system
  }

  get supervisor(): Supervisor {
    return this.#supervisor
  }

  get store(): PersistenceStore {
    return required(this.#store, 'store')
  }

  get engine(): StateEngine {
    return required(this.#engine, 'engine')
  }

  get hub(): RendererHub {
    return required(this.#hub, 'hub')
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.#port)}`
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${String(this.#port)}/ws/renderer`
  }

  get backendRestarts(): number {
    return this.#backendRestarts
  }

  /** Envelopes this system has posted, for the "nothing was lost" arithmetic. */
  get postedEnvelopes(): number {
    return this.#sequence
  }

  // ------------------------------------------------------------------ start-up

  async #boot(): Promise<void> {
    this.#openBackend()
    await this.#listen(0)
  }

  /** Runs the §7.3(3) start-up sequence and the §9.2 pre-checks. */
  async startSupervisor(): Promise<void> {
    await this.#supervisor.start()
    await flushEventLoop()
  }

  /**
   * Start-up as an operator would see it: the sequence runs, the renderer
   * attaches, and the machine reaches `live` on its own.
   *
   * The renderer connects **after** the sequence because the `renderer`
   * pre-check is meant to fail until one attaches — that is §9.2's `starting`
   * state and §9.1's "일시 장애 자동 복구", and the supervisor's own
   * `preflightRetryIntervalMs` re-reads the checks. A soak that pre-attached
   * everything would never exercise that path.
   */
  async bringUp(sliceMs = 5_000, maxTicks = 60): Promise<void> {
    await this.startSupervisor()
    await this.renderer.connectTo(this.wsUrl)
    await flushEventLoop()
    for (let tick = 0; tick < maxTicks && this.#supervisor.state !== 'live'; tick += 1) {
      await this.tick(sliceMs)
    }
    if (this.#supervisor.state !== 'live') {
      throw new Error(
        `soak system did not reach live: state=${this.#supervisor.state} reason=${this.#supervisor.health().lastTransitionReason}`,
      )
    }
  }

  #openBackend(): void {
    const store = PersistenceStore.open({
      file: this.file,
      busyTimeoutMs: this.#busyTimeoutMs,
      clock: this.clock,
    })
    const gate = withDiskFull(store, this.#diskFullErrorOrCapture())
    this.#store = store
    this.#diskFull = gate

    const ingest = new SimulatorIngestEndpoint({
      inbox: { ingest: (envelopes, checkpoint) => this.engine.ingest(envelopes, checkpoint) },
      enabled: true,
      token: this.simulatorToken,
      onIngested: () => {
        this.engine.pump()
      },
    })
    const http = createServer({
      engine: {
        health: () => this.engine.health(),
        metrics: () => this.engine.metrics(),
      },
      ingest,
      rendererHealth: () => this.hub.lastHealth,
      sourceHealth: () => this.chat.signals(),
      supervisorHealth: () => this.#supervisor.health(),
    })
    const hub = new RendererHub({
      server: http,
      clock: this.clock,
      token: this.rendererToken,
      events: {
        onHello: (revision) => {
          this.engine.onRendererHello(revision)
        },
        onAckState: (revision, appliedAt) => {
          this.engine.onAckState(revision, appliedAt)
        },
        onAckEffect: (effectId, appliedAt) => {
          this.engine.onAckEffect(effectId, appliedAt)
        },
        onHealth: () => {},
      },
    })
    this.#http = http
    this.#hub = hub
    this.#engine = new StateEngine({
      store: gate.store,
      clock: this.clock,
      config: this.config,
      inputConfig: this.inputConfig,
      publisher: hub,
      autoTick: false,
    })
  }

  #diskFullErrorOrCapture(): unknown {
    this.#diskFullError ??= captureDiskFullError()
    return this.#diskFullError
  }

  async #listen(port: number): Promise<void> {
    const http = required(this.#http, 'http server')
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(port, '127.0.0.1', () => {
        http.removeListener('error', reject)
        resolve()
      })
    })
    const address = http.address()
    if (address === null || typeof address === 'string') {
      throw new Error('soak system could not read the listening port')
    }
    this.#port = address.port
  }

  // -------------------------------------------------------------------- faults

  /** Holds the SQLite write lock, so the next writer pass gets `SQLITE_BUSY`. */
  holdWriteLock(): void {
    this.#lock ??= WriteLockHolder.open(this.file, this.#busyTimeoutMs)
    this.#lock.acquire()
  }

  releaseWriteLock(): void {
    this.#lock?.release()
  }

  /** Writes fail with a real `SQLITE_FULL` until `freeDisk()`. */
  fillDisk(): void {
    required(this.#diskFull, 'disk gate').arm()
  }

  freeDisk(): void {
    required(this.#diskFull, 'disk gate').disarm()
  }

  get refusedWrites(): number {
    return this.#diskFull?.refusals ?? 0
  }

  /**
   * A backend restart against the same database file: the engine stops, the HTTP
   * and WS surfaces close, everything is rebuilt on the same port and the
   * renderer reattaches. Only what was committed survives (spec §11 상태 복구).
   */
  async restartBackend(): Promise<void> {
    const port = this.#port
    await this.renderer.disconnect()
    await this.#teardownBackend()
    this.#backendRestarts += 1
    this.#openBackend()
    await this.#listen(port)
    this.engine.start()
    await this.renderer.connectTo(this.wsUrl)
    await flushEventLoop()
  }

  // ---------------------------------------------------------------- the loop

  /**
   * One slice of scenario time: move the clock, let every producer observe, run
   * one writer pass and one supervisor evaluation.
   *
   * The order matters. Signals are pushed **immediately before** the evaluation
   * that reads them, because the aggregator drops a report older than
   * `supervisor.signalStaleAfterMs` — a slice coarser than that window would
   * otherwise report every pushed family as unobservable no matter how healthy
   * it was.
   */
  async tick(elapsedMs: number): Promise<void> {
    if (this.#virtualClock !== undefined) {
      await this.#virtualClock.advance(elapsedMs)
    } else if (elapsedMs > 0) {
      await sleep(elapsedMs)
    }

    this.chat.poll()
    this.broadcast.pollHealth()
    this.renderer.reportHealth(elapsedMs)

    for (const signal of this.obs.signals()) this.#supervisor.report(signal)
    for (const signal of this.broadcast.signals()) this.#supervisor.report(signal)

    this.engine.pump()
    await flushEventLoop()
    await this.#supervisor.evaluate()
    await flushEventLoop()
  }

  /** Posts `count` synthetic commands over real HTTP (`POST /ingest/simulator`). */
  async inject(count: number): Promise<number> {
    if (count <= 0) return 0
    const envelopes = soakCommandBatch(this.#sequence, count, this.clock.nowUtcIso())
    this.#sequence += count
    const response = await postEnvelopes(
      { baseUrl: this.baseUrl, token: this.simulatorToken },
      envelopes,
    )
    this.chat.noteUserEvent()
    this.engine.pump()
    await flushEventLoop()
    return response.inserted
  }

  observe(): SoakObservation {
    const health: SupervisorHealthSummary = this.#supervisor.health()
    const engine = this.engine.health()
    return {
      state: health.state,
      interactionEnabled: health.interactionEnabled,
      degradedFamilies: this.#supervisor.aggregate?.degradedFamilies ?? [],
      safeStopKind: health.safeStop?.kind ?? null,
      engineReady: engine.ready,
      stateRevision: engine.stateRevision,
      processedIngestSeq: engine.processedIngestSeq,
      consecutiveWriterFailures: engine.consecutiveFailures,
      rendererFrameCounter: this.renderer.frameCounter,
      webglContextLost: this.renderer.webglContextLost,
    }
  }

  /** Signals the supervisor is currently holding, for diagnostics. */
  signals(): readonly HealthSignal[] {
    return [...this.obs.signals(), ...this.broadcast.signals(), ...this.chat.signals()]
  }

  async close(): Promise<void> {
    this.#supervisor.stop()
    this.#lock?.close()
    this.#lock = null
    await this.renderer.disconnect()
    await this.#teardownBackend()
    await this.auth.close()
    rmSync(this.directory, { recursive: true, force: true })
  }

  async #teardownBackend(): Promise<void> {
    this.#engine?.stop()
    this.#hub?.close()
    const http = this.#http
    if (http !== null) {
      await new Promise<void>((resolve) => {
        http.closeAllConnections()
        http.close(() => {
          resolve()
        })
      })
    }
    try {
      this.#store?.close()
    } catch {
      // Already closed by a previous teardown; the files still have to go.
    }
    this.#engine = null
    this.#hub = null
    this.#http = null
    this.#store = null
    this.#diskFull = null
  }
}

/**
 * The supervisor configuration a soak runs under.
 *
 * It starts from `config/default.json` and changes only what a headless run must
 * change: OBS and the broadcast are wired (their adapters are the injectable
 * ones), Discord delivery is off because a soak must reach no external service,
 * and the dead-man push is off for the same reason. Every threshold is left
 * exactly as configured — a drill that quietly relaxed one would be measuring a
 * different supervisor.
 */
export function soakSupervisorConfig(restartDelayMs?: number): SupervisorConfig {
  const base = loadSupervisorConfig({ env: {} })
  return {
    ...base,
    integrations: { obs: true, broadcast: true },
    alerts: { ...base.alerts, discordEnabled: false },
    deadMan: { ...base.deadMan, enabled: false },
    screenshot: { ...base.screenshot, enabled: false },
    ...(restartDelayMs === undefined
      ? {}
      : {
          restart: { ...base.restart, initialDelayMs: restartDelayMs, maxDelayMs: restartDelayMs },
        }),
  }
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`soak system has no ${what}; call start() first`)
  return value
}

async function sleep(millis: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, millis)
  })
}
