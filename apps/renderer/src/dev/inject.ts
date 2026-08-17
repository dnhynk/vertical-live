import type { IngestEnvelope } from '@vl/contract'
import {
  BUILTIN_SCENARIOS,
  parseScenario,
  planScenario,
  requiresParser,
  type Scenario,
  type ScenarioStepInput,
} from '@vl/simulator/scenario'

/**
 * `?mode=dev` event injection (TASK_SPECS §T11).
 *
 * The panel drives the world **through the server API only**: it builds the same
 * `IngestEnvelope`s the CLI builds — from `@vl/simulator/scenario`, so there is
 * one definition and not two — and posts them to `POST /ingest/simulator`.
 * Nothing here touches the read model. A renderer that could change what is on
 * screen without the server would stop being a read model, which is the
 * invariant spec §10.2 is built on.
 *
 * The token comes from `?simToken=` and is never rendered; the outcome the panel
 * shows is a status token, not the response body.
 */

export type InjectOutcome =
  /** 202: the batch is in the inbox. */
  | 'accepted'
  /** 404: `simulator.enabled` is false, or this build has no such route. */
  | 'disabled'
  /** 401: no `?simToken=`, or the wrong one. */
  | 'unauthorized'
  /** 403: not loopback. */
  | 'refused'
  /** 400/413: the endpoint rejected the body. */
  | 'rejected'
  /** The request never got an answer. */
  | 'unreachable'

export interface InjectResult {
  readonly outcome: InjectOutcome
  readonly status: number | null
  readonly inserted: number
  readonly duplicates: number
}

export interface SimulatorClientOptions {
  /** `http://127.0.0.1:8787`, from `RendererConfig.apiUrl`. */
  readonly apiUrl: string
  readonly token: string | null
  /** Injected in tests; the browser's `fetch` otherwise. */
  readonly fetchImpl?: typeof fetch
  /** Injected in tests; `Date.now` otherwise. */
  readonly now?: () => number
  /** Injected in tests; `setTimeout` otherwise. */
  readonly delay?: (millis: number) => Promise<void>
}

/** Scenarios the panel can play: no parser needed, no virtual clock needed. */
export function panelScenarios(): Scenario[] {
  return BUILTIN_SCENARIOS.filter(
    (scenario) => !requiresParser(scenario) && !scenario.requiresVirtualClock,
  )
}

/** Single events the panel offers, as one-step scenarios (spec §2.6 ids). */
export const SINGLE_EVENTS: readonly { id: string; label: string; step: ScenarioStepInput }[] = [
  { id: 'feed', label: 'FEED', step: { kind: 'command', atMs: 0, command: 'FEED' } },
  { id: 'play', label: 'PLAY', step: { kind: 'command', atMs: 0, command: 'PLAY' } },
  { id: 'pet', label: 'PET', step: { kind: 'command', atMs: 0, command: 'PET' } },
  {
    id: 'super-chat',
    label: 'Super Chat',
    step: { kind: 'superChat', atMs: 0, amountMicros: 500_000, currency: 'JPY', tier: 1 },
  },
  {
    id: 'gift',
    label: 'Gift x3',
    step: { kind: 'gift', atMs: 0, comboCount: 3, jewels: 10, giftName: 'sim_gift' },
  },
  {
    id: 'membership',
    label: 'Membership',
    step: { kind: 'membership', atMs: 0, tier: 1 },
  },
]

export class SimulatorClient {
  readonly #options: SimulatorClientOptions
  /** Per page load; a second press is a second delivery, not a replay. */
  #run = 0

  constructor(options: SimulatorClientOptions) {
    this.#options = options
  }

  get authenticated(): boolean {
    return this.#options.token !== null
  }

  async injectSingle(id: string): Promise<InjectResult> {
    const entry = SINGLE_EVENTS.find((event) => event.id === id)
    if (entry === undefined) throw new Error(`unknown single event: ${id}`)
    const scenario = parseScenario({
      id: 'dev-panel',
      title: 'Dev panel injection',
      summary: 'One synthetic event injected by hand from the ?mode=dev panel.',
      steps: [entry.step],
    })
    const plan = planScenario(scenario, { broadcastSuffix: this.#nextRunTag() })
    const batch = plan.batches[0]
    if (batch === undefined)
      return { outcome: 'rejected', status: null, inserted: 0, duplicates: 0 }
    return this.post(batch.build(this.#nowIso()))
  }

  /**
   * Plays a scenario in real time. The panel is a diagnostic, so the offsets are
   * honoured rather than compressed: the window boundaries of spec §6.4 are what
   * an operator is usually watching for.
   */
  async runScenario(
    scenario: Scenario,
    onBatch?: (result: InjectResult) => void,
  ): Promise<InjectResult> {
    const plan = planScenario(scenario, { broadcastSuffix: this.#nextRunTag() })
    let inserted = 0
    let duplicates = 0
    let cursorMs = 0
    for (const batch of plan.batches) {
      if (batch.atMs > cursorMs) await this.#sleep(batch.atMs - cursorMs)
      cursorMs = batch.atMs
      const envelopes = batch.build(this.#nowIso())
      if (envelopes.length === 0) continue
      const result = await this.post(envelopes)
      onBatch?.(result)
      if (result.outcome !== 'accepted') return result
      inserted += result.inserted
      duplicates += result.duplicates
    }
    return { outcome: 'accepted', status: 202, inserted, duplicates }
  }

  async post(envelopes: readonly IngestEnvelope[]): Promise<InjectResult> {
    const fetchImpl = this.#options.fetchImpl ?? globalThis.fetch
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#options.token !== null) headers['authorization'] = `Bearer ${this.#options.token}`
    let response: Response
    try {
      response = await fetchImpl(`${this.#options.apiUrl}/ingest/simulator`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ envelopes }),
      })
    } catch {
      // The body is never inspected or shown: it could echo a server error, and
      // the panel is on screen (spec §12.3).
      return { outcome: 'unreachable', status: null, inserted: 0, duplicates: 0 }
    }
    const body: unknown = await response.json().catch(() => null)
    return {
      outcome: outcomeFor(response.status),
      status: response.status,
      inserted: readInt(body, 'inserted'),
      duplicates: readInt(body, 'duplicates'),
    }
  }

  #nextRunTag(): string {
    this.#run += 1
    return `r${String(this.#run)}`
  }

  #nowIso(): string {
    return new Date(this.#options.now?.() ?? Date.now()).toISOString()
  }

  async #sleep(millis: number): Promise<void> {
    const delay = this.#options.delay
    if (delay !== undefined) {
      await delay(millis)
      return
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, millis)
    })
  }
}

function outcomeFor(status: number): InjectOutcome {
  if (status === 202) return 'accepted'
  if (status === 404) return 'disabled'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'refused'
  return 'rejected'
}

function readInt(body: unknown, key: string): number {
  if (typeof body !== 'object' || body === null) return 0
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
