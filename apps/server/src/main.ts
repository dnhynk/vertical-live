import { systemClock } from './clock.js'
import { PersistenceStore } from './db/store.js'
import { loadEngineConfig } from './engine/config.js'
import { StateEngine } from './engine/engine.js'
import { SimulatorIngestEndpoint } from './engine/ingest.js'
import { RendererHub } from './engine/publisher.js'
import { loadInputConfig } from './input/config.js'
import { defaultSecretProvider } from './secrets/resolve.js'
import { requireSecret } from './secrets/types.js'
import { createServer, DEFAULT_HOST, resolvePort } from './server.js'

/**
 * Process entry point: one store, one engine, one renderer hub, one HTTP
 * surface, all on loopback (spec §10.2, TASK_SPECS 공통 규약).
 *
 * The three collaborators are mutually referential — the hub needs the HTTP
 * server, the engine publishes through the hub, and both HTTP and the hub call
 * back into the engine — so the references are taken inside callbacks that only
 * run once every binding exists. The engine is started after the listener is up,
 * so a renderer reconnecting during start-up finds the socket and gets the
 * recovery snapshot instead of a connection error.
 */

const config = loadEngineConfig()
const inputConfig = loadInputConfig()
const port = resolvePort()
const store = PersistenceStore.fromConfig({ clock: systemClock })

const secrets = defaultSecretProvider()

// The renderer API is loopback *and* authenticated (spec §10.2), so the token is
// required to start: a server that silently accepted no renderer would look
// healthy while the broadcast showed nothing.
const rendererToken = await requireSecret(
  secrets,
  'server.rendererToken',
  'set it with `npm run secrets -w @vl/server -- set server.rendererToken` and inject it into the OBS Browser Source URL (docs/ops/obs-setup.md)',
)

// The simulator token is only read when the endpoint is enabled: a production
// broadcast never touches that credential (spec §10.2).
const simulatorToken = config.simulator.enabled
  ? ((await secrets.get('server.simulatorToken')) ?? null)
  : null

const ingest = new SimulatorIngestEndpoint({
  // Through the engine, not the store: that is where the storage-boundary
  // sanitizer and the inbox notification live.
  inbox: { ingest: (envelopes, checkpoint) => engine.ingest(envelopes, checkpoint) },
  enabled: config.simulator.enabled,
  token: simulatorToken,
  onIngested: () => {
    // `pump()` records a failed pass on `/health` instead of turning it into an
    // unhandled rejection in the HTTP handler.
    engine.pump()
  },
})

const httpServer = createServer({
  engine: {
    health: () => engine.health(),
    metrics: () => engine.metrics(),
  },
  ingest,
  rendererHealth: () => hub.lastHealth,
})

const hub = new RendererHub({
  server: httpServer,
  clock: systemClock,
  token: rendererToken,
  events: {
    onHello: (lastAppliedStateRevision) => {
      engine.onRendererHello(lastAppliedStateRevision)
    },
    onAckState: (stateRevision, appliedAt) => {
      engine.onAckState(stateRevision, appliedAt)
    },
    onAckEffect: (effectId, appliedAt) => {
      engine.onAckEffect(effectId, appliedAt)
    },
    onHealth: () => {
      // Recorded by the hub and read through `/health`; T12 aggregates it.
    },
  },
})

const engine = new StateEngine({
  store,
  clock: systemClock,
  config,
  inputConfig,
  publisher: hub,
})

httpServer.listen(port, DEFAULT_HOST, () => {
  engine.start()
  process.stdout.write(`@vl/server listening on http://${DEFAULT_HOST}:${port}\n`)
})
