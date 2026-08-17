import { systemClock } from './clock.js'
import { PersistenceStore } from './db/store.js'
import { loadEngineConfig } from './engine/config.js'
import { StateEngine } from './engine/engine.js'
import { SimulatorIngestEndpoint } from './engine/ingest.js'
import { RendererHub } from './engine/publisher.js'
import { loadInputConfig } from './input/config.js'
import { defaultSecretProvider } from './secrets/resolve.js'
import { createServer, DEFAULT_HOST, resolvePort } from './server.js'

/**
 * Process entry point: one store, one engine, one renderer hub, one HTTP
 * surface, all on loopback (spec §10.2, TASK_SPECS 공통 규약).
 *
 * The engine is started after the listener is up so a renderer that reconnects
 * during start-up finds the socket and receives the recovery snapshot rather
 * than a connection error.
 */

const config = loadEngineConfig()
const inputConfig = loadInputConfig()
const port = resolvePort()
const store = PersistenceStore.fromConfig({ clock: systemClock })

// The simulator token is only read when the endpoint is enabled: a production
// broadcast never touches that credential (spec §10.2).
const simulatorToken = config.simulator.enabled
  ? ((await defaultSecretProvider().get('server.simulatorToken')) ?? null)
  : null

let engine: StateEngine | undefined
let hub: RendererHub | undefined

const ingest = new SimulatorIngestEndpoint({
  store,
  enabled: config.simulator.enabled,
  token: simulatorToken,
  onIngested: () => {
    engine?.notifyIngest()
    engine?.runPending()
  },
})

const httpServer = createServer({
  engine: {
    health: () => requireEngine().health(),
    metrics: () => requireEngine().metrics(),
  },
  ingest,
  rendererHealth: () => hub?.lastHealth ?? null,
})

hub = new RendererHub({
  server: httpServer,
  clock: systemClock,
  events: {
    onHello: (lastAppliedStateRevision) => {
      requireEngine().onRendererHello(lastAppliedStateRevision)
    },
    onAckState: (stateRevision, appliedAt) => {
      requireEngine().onAckState(stateRevision, appliedAt)
    },
    onAckEffect: (effectId, appliedAt) => {
      requireEngine().onAckEffect(effectId, appliedAt)
    },
    onHealth: () => {
      // Recorded by the hub; the supervisor (T12) aggregates it.
    },
  },
})

engine = new StateEngine({
  store,
  clock: systemClock,
  config,
  inputConfig,
  publisher: hub,
})

httpServer.listen(port, DEFAULT_HOST, () => {
  requireEngine().start()
  process.stdout.write(`@vl/server listening on http://${DEFAULT_HOST}:${port}\n`)
})

function requireEngine(): StateEngine {
  if (engine === undefined) throw new Error('engine is not constructed yet')
  return engine
}
