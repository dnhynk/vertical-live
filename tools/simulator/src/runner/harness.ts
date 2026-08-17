import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createServer,
  loadEngineConfig,
  PersistenceStore,
  RendererHub,
  SimulatorIngestEndpoint,
  StateEngine,
  systemClock,
  type Clock,
  type EngineRuntimeConfig,
} from '@vl/server'
import { loadInputConfig, type InputConfig } from '@vl/server/input'

/**
 * A whole backend in one process: store, single-writer engine, renderer hub and
 * the HTTP surface, on an ephemeral loopback port.
 *
 * It is assembled exactly like `apps/server/src/main.ts` — same wiring, same
 * order — with three deliberate differences:
 *
 * - the clock is injected, so a scenario can run on a virtual one (§T11
 *   acceptance 1);
 * - `autoTick` is off, so the writer loop advances only when the runner says so
 *   and never interleaves with an assertion;
 * - the tokens are generated per harness and the database is a temporary file,
 *   so no real vault value and no operational database is ever touched
 *   (CLAUDE.md §3 비밀정보).
 *
 * Injection still goes over **real HTTP** to `POST /ingest/simulator`. That is
 * the point of the harness: the endpoint's 404/403/401/400 paths are part of the
 * contract the simulator is supposed to exercise (§T11 acceptance 3), and
 * calling `engine.ingest()` directly would skip all of them.
 *
 * `restart()` is a genuine backend restart: the engine stops, the HTTP and WS
 * surfaces close, the database file is reopened and everything is rebuilt on the
 * same port. Only what was committed survives, which is what spec §11 상태 복구
 * asks to be proven.
 */

export interface SimulatorHarnessOptions {
  readonly clock?: Clock
  readonly config?: EngineRuntimeConfig
  readonly inputConfig?: InputConfig
  /** Overrides the generated bearer token, for the "wrong token" path. */
  readonly simulatorToken?: string
  readonly rendererToken?: string
  /** `simulator.enabled`; `false` makes the endpoint answer 404. */
  readonly simulatorEnabled?: boolean
  readonly busyTimeoutMs?: number
}

export const HARNESS_BUSY_TIMEOUT_MS = 250

export class SimulatorHarness {
  readonly clock: Clock
  readonly config: EngineRuntimeConfig
  readonly inputConfig: InputConfig
  readonly simulatorToken: string
  readonly rendererToken: string
  readonly simulatorEnabled: boolean
  readonly directory: string
  readonly file: string
  readonly #busyTimeoutMs: number

  #store: PersistenceStore | null = null
  #engine: StateEngine | null = null
  #hub: RendererHub | null = null
  #http: Server | null = null
  #port = 0
  #restarts = 0

  constructor(options: SimulatorHarnessOptions = {}) {
    this.clock = options.clock ?? systemClock
    this.config = options.config ?? loadEngineConfig({ env: {} })
    this.inputConfig = options.inputConfig ?? loadInputConfig({ env: {} })
    // Obviously synthetic, generated per harness, never persisted or printed.
    this.simulatorToken = options.simulatorToken ?? `sim_token_${randomSuffix()}`
    this.rendererToken = options.rendererToken ?? `renderer_token_${randomSuffix()}`
    this.simulatorEnabled = options.simulatorEnabled ?? true
    this.directory = mkdtempSync(join(tmpdir(), 'vl-sim-'))
    this.file = join(this.directory, 'vertical-live.db')
    this.#busyTimeoutMs = options.busyTimeoutMs ?? HARNESS_BUSY_TIMEOUT_MS
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

  get port(): number {
    return this.#port
  }

  get restartCount(): number {
    return this.#restarts
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.#port)}`
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${String(this.#port)}/ws/renderer`
  }

  async start(): Promise<void> {
    if (this.#http !== null) throw new Error('simulator harness is already started')
    this.#store = PersistenceStore.open({
      file: this.file,
      busyTimeoutMs: this.#busyTimeoutMs,
      clock: this.clock,
    })
    this.#build()
    await this.#listen(this.#port)
    this.engine.start()
  }

  /** Restarts the backend against the same database file (spec §11 상태 복구). */
  async restart(): Promise<void> {
    await this.#teardown()
    this.#restarts += 1
    this.#store = PersistenceStore.open({
      file: this.file,
      busyTimeoutMs: this.#busyTimeoutMs,
      clock: this.clock,
    })
    this.#build()
    await this.#listen(this.#port)
    this.engine.start()
  }

  async close(): Promise<void> {
    await this.#teardown()
    rmSync(this.directory, { recursive: true, force: true })
  }

  #build(): void {
    const ingest = new SimulatorIngestEndpoint({
      inbox: { ingest: (envelopes, checkpoint) => this.engine.ingest(envelopes, checkpoint) },
      enabled: this.simulatorEnabled,
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
      store: this.store,
      clock: this.clock,
      config: this.config,
      inputConfig: this.inputConfig,
      publisher: hub,
      autoTick: false,
    })
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
      throw new Error('simulator harness could not read the listening port')
    }
    this.#port = address.port
  }

  async #teardown(): Promise<void> {
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
  }
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`simulator harness has no ${what}; call start() first`)
  return value
}

/**
 * A fresh bearer token per harness. It is a credential, so it comes from the
 * CSPRNG and not from a seeded RNG: nothing in a scenario's outcome depends on
 * it, and a predictable token in a loopback-listening process would be worse
 * than a non-reproducible one (spec §10.2).
 */
function randomSuffix(): string {
  return randomBytes(16).toString('hex')
}
