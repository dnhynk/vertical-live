import { useMemo, useState } from 'react'

import { SimulatorClient, SINGLE_EVENTS, panelScenarios, type InjectResult } from '../dev/inject'
import type { RendererRuntime } from '../runtime'

/**
 * The `?mode=dev` injection controls of TASK_SPECS §T11.
 *
 * Everything it does goes out over `POST /ingest/simulator` and comes back in
 * over the WebSocket as a server snapshot. There is no path from a button here
 * to the read model: the renderer stays a read model of the server's world
 * (spec §10.2), and a scenario played from this panel is the same definition the
 * CLI plays (`@vl/simulator/scenario`).
 *
 * Nothing secret is drawn. `?simToken=` is a vault value, so the panel reports
 * only whether a token is present and what status token the endpoint answered
 * with (R-T8-2 blocker 1, spec §12.3).
 */
export interface DevInjectorProps {
  runtime: RendererRuntime
  /** Injected by the tests; the real client otherwise. */
  client?: SimulatorClient
}

export default function DevInjector({ runtime, client }: DevInjectorProps) {
  const simulator = useMemo(
    () =>
      client ??
      new SimulatorClient({
        apiUrl: runtime.config.apiUrl,
        token: runtime.config.simToken,
      }),
    [client, runtime.config.apiUrl, runtime.config.simToken],
  )
  const scenarios = useMemo(() => panelScenarios(), [])
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<InjectResult | null>(null)

  const send = (task: () => Promise<InjectResult>): void => {
    if (busy) return
    setBusy(true)
    void task()
      .then(setResult)
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <section className="dev-sim" data-testid="dev-injector">
      <h3 className="dev-sim-title">simulator</h3>
      <p className="dev-sim-note" data-testid="dev-sim-auth">
        {simulator.authenticated ? 'token: present' : 'token: missing (?simToken=)'}
      </p>
      <div className="dev-sim-buttons">
        {SINGLE_EVENTS.map((event) => (
          <button
            key={event.id}
            type="button"
            data-testid={`dev-inject-${event.id}`}
            disabled={busy}
            onClick={() => {
              send(() => simulator.injectSingle(event.id))
            }}
          >
            {event.label}
          </button>
        ))}
      </div>
      <div className="dev-sim-scenario">
        <select
          aria-label="scenario"
          data-testid="dev-scenario-select"
          value={scenarioId}
          disabled={busy}
          onChange={(event) => {
            setScenarioId(event.target.value)
          }}
        >
          {scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="dev-scenario-run"
          disabled={busy || scenarioId === ''}
          onClick={() => {
            const scenario = scenarios.find((entry) => entry.id === scenarioId)
            if (scenario === undefined) return
            send(() => simulator.runScenario(scenario))
          }}
        >
          run
        </button>
      </div>
      <p className="dev-sim-result" data-testid="dev-sim-result">
        {result === null
          ? busy
            ? 'running'
            : 'idle'
          : `${result.outcome} (${result.status === null ? 'no response' : String(result.status)}) inserted=${String(result.inserted)} duplicates=${String(result.duplicates)}`}
      </p>
    </section>
  )
}
