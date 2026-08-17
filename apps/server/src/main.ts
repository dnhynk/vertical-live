import { systemClock } from './clock.js'
import { PersistenceStore } from './db/store.js'
import { loadEngineConfig } from './engine/config.js'
import { StateEngine } from './engine/engine.js'
import { SimulatorIngestEndpoint } from './engine/ingest.js'
import { RendererHub } from './engine/publisher.js'
import { loadInputConfig } from './input/config.js'
import { loadRetentionConfig } from './privacy/config.js'
import { RetentionSweeper } from './privacy/retention.js'
import {
  RevocationAuthEventSink,
  RevocationHandler,
  vaultGrantRevoker,
} from './privacy/revocation.js'
import { RetentionScheduler } from './privacy/scheduler.js'
import { ObsClient } from './obs/client.js'
import { loadObsConfig } from './obs/config.js'
import { ObsControl } from './obs/control.js'
import { ObsHealthMonitor } from './obs/health.js'
import type { LogFields, Logger } from './secrets/redaction.js'
import { defaultSecretProvider, resolveSecretVault } from './secrets/resolve.js'
import { requireSecret } from './secrets/types.js'
import { createServer, DEFAULT_HOST, resolvePort } from './server.js'
import {
  CompositeAlertSink,
  DiscordWebhookAlertSink,
  SuppressingAlertSink,
  type AlertSink,
} from './supervisor/alerts.js'
import { loadSupervisorConfig } from './supervisor/config.js'
import { DeadManMonitor } from './supervisor/deadman.js'
import { AdminKillEndpoint, KillSwitchFileWatcher } from './supervisor/kill-switch.js'
import {
  buildPreflightProbes,
  buildStartupSteps,
  type BroadcastPort,
  type ObsPort,
} from './supervisor/runtime.js'
import { DiagnosticScreenshotRecorder } from './supervisor/screenshot.js'
import { Supervisor } from './supervisor/supervisor.js'
import { loadYouTubeAuthConfig } from './youtube/auth/config.js'
import type { AuthEventSink } from './youtube/auth/events.js'
import type { ChatSource } from './youtube/chat/chat-source.js'
import { loadChatConfig } from './youtube/chat/config.js'
import { createChatSource } from './youtube/chat/runtime.js'

/**
 * Process entry point: one store, one engine, one renderer hub, one HTTP
 * surface, one supervisor, all on loopback (spec §10.2, TASK_SPECS 공통 규약).
 *
 * The collaborators are mutually referential — the hub needs the HTTP server,
 * the engine publishes through the hub, the supervisor reads both and the HTTP
 * surface reads the supervisor — so the references are taken inside callbacks
 * that only run once every binding exists.
 *
 * Nothing here decides anything. The start-up order, the pre-checks and the
 * state machine live in `supervisor/`, where they are tested; this file only
 * builds the real adapters and hands them over.
 */

const stdoutLogger: Logger = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
}

function write(level: string, message: string, fields?: LogFields): void {
  process.stdout.write(
    `${JSON.stringify({ at: systemClock.nowUtcIso(), level, message, ...fields })}\n`,
  )
}

const config = loadEngineConfig()
const inputConfig = loadInputConfig()
const supervisorConfig = loadSupervisorConfig()
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

// The kill switch is the operator's emergency stop (spec §9.1), so its token is
// read at start-up: discovering it is missing while a broadcast has to be
// stopped is exactly the wrong moment.
const adminToken = await requireSecret(
  secrets,
  'server.adminToken',
  'set it with `npm run secrets -w @vl/server -- set server.adminToken`; it authenticates POST /admin/kill (spec §10.2)',
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

// Declared before the HTTP server so `/health` can read them through a closure;
// they are only built after the engine exists.
let chatSource: ChatSource | null = null

const httpServer = createServer({
  engine: {
    health: () => engine.health(),
    metrics: () => engine.metrics(),
  },
  ingest,
  rendererHealth: () => hub.lastHealth,
  sourceHealth: () => chatSource?.signals() ?? [],
  supervisorHealth: () => supervisor.health(),
  adminKill: new AdminKillEndpoint({
    token: adminToken,
    clock: systemClock,
    onKill: (request) => {
      supervisor.onKillSwitch(request)
    },
  }),
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
      // Recorded by the hub, read by the supervisor's aggregator (spec §9.4(4)).
    },
  },
})

const engine = new StateEngine({
  store,
  clock: systemClock,
  config,
  inputConfig,
  publisher: hub,
  logger: stdoutLogger,
})

// ------------------------------------------------------------------ alerts

const alertSinks: AlertSink[] = []
if (supervisorConfig.alerts.discordEnabled) {
  alertSinks.push(
    new DiscordWebhookAlertSink({
      // Read per delivery: the webhook URL is a credential and is never held in
      // config, logs or `/health` (spec §10.2, BOARD D-3).
      webhookUrl: () => secrets.get('alerts.discordWebhookUrl'),
      config: supervisorConfig.alerts,
      clock: systemClock,
      logger: stdoutLogger,
    }),
  )
}
const alerts = new SuppressingAlertSink({
  delegate: new CompositeAlertSink(alertSinks),
  config: supervisorConfig.alerts,
  clock: systemClock,
})

// --------------------------------------------------------------------- OBS

let obsClient: ObsClient | null = null
let obsControl: ObsControl | null = null
let obsPort: ObsPort | null = null
if (supervisorConfig.integrations.obs) {
  const obsConfig = loadObsConfig()
  const client = new ObsClient({
    config: obsConfig,
    secrets,
    clock: systemClock,
    onSignal: (signal) => {
      supervisor.report(signal)
    },
  })
  const control = new ObsControl({
    source: client,
    config: obsConfig,
    clock: systemClock,
    secrets,
  })
  new ObsHealthMonitor({
    source: client,
    config: obsConfig,
    clock: systemClock,
    onSignal: (signal) => {
      supervisor.report(signal)
    },
  }).start()
  obsClient = client
  obsControl = control
  obsPort = {
    connected: () => client.state === 'connected',
    setStreamServiceFromVault: async () => {
      // The connection is established here rather than in a step of its own:
      // `ObsClient` owns the OBS-connection restart loop (spec §10.2), and this
      // is the first call that needs the socket.
      await client.connect()
      return control.setStreamServiceFromVault()
    },
    startStream: () => control.startStream(),
  }
}

// ------------------------------------------------------------- supervisor

// The YouTube broadcast lifecycle (T10) needs an OAuth grant and a channel, so
// it is only wired where an operator has provisioned one. Without it the run
// keeps its world going (spec §2.1) and the `api`/`credentials` pre-checks fail
// with `not_configured` instead of pretending a broadcast exists.
const broadcastPort: BroadcastPort | null = null

const deadMan: DeadManMonitor = new DeadManMonitor({
  pushUrl: () => secrets.get('monitoring.deadManPushUrl'),
  config: supervisorConfig.deadMan,
  clock: systemClock,
  logger: stdoutLogger,
  message: (): string => supervisor.state,
})

const screenshots =
  obsClient === null
    ? undefined
    : new DiagnosticScreenshotRecorder({
        source: obsClient,
        config: supervisorConfig.screenshot,
        clock: systemClock,
        logger: stdoutLogger,
      })

const runtimeDeps = {
  config: supervisorConfig,
  engine: {
    start: () => {
      engine.start()
    },
    get ready() {
      return engine.ready
    },
    health: () => engine.health(),
  },
  openStore: () => {
    store.assertReady()
  },
  retention: new RetentionScheduler({
    sweeper: new RetentionSweeper({
      store,
      clock: systemClock,
      config: loadRetentionConfig(),
      logger: stdoutLogger,
    }),
    clock: systemClock,
    onResult: (result) => {
      supervisor.onRetentionResult({
        clean: result.clean,
        rowsUnprocessed: result.rowsUnprocessed,
      })
    },
    onError: (error) => {
      supervisor.onRetentionError(error)
    },
    logger: stdoutLogger,
  }),
  broadcast: broadcastPort,
  obs: obsPort,
  chat: {
    start: () => {
      chatSource?.start()
    },
  },
  logger: stdoutLogger,
}

const supervisor: Supervisor = new Supervisor({
  config: supervisorConfig,
  clock: systemClock,
  engine: {
    health: () => engine.health(),
    reportInputHealth: (health) => {
      engine.reportInputHealth(health)
    },
  },
  renderer: () => hub.lastHealth,
  // T9 reports §9.4(3) as a snapshot; OBS and the broadcast monitor push theirs.
  sources: () => chatSource?.signals() ?? [],
  alerts,
  deadMan,
  ...(screenshots === undefined ? {} : { screenshots }),
  logger: stdoutLogger,
  startup: buildStartupSteps(runtimeDeps),
  preflight: buildPreflightProbes({ ...runtimeDeps, secrets }),
  actions: {
    engine: () => {
      engine.stop()
      engine.start()
      return Promise.resolve()
    },
    chatSource: async () => {
      await chatSource?.stop()
      chatSource?.start()
    },
    obsStream: async () => {
      if (obsControl === null) throw new Error('obs integration is not configured')
      await obsControl.startStream()
    },
    rendererSource: async () => {
      if (obsControl === null) throw new Error('obs integration is not configured')
      await obsControl.refreshBrowserSource()
    },
    obsProcess: () =>
      // Launching OBS itself is T17's Windows script. Until it is wired the
      // escalation fails honestly, which is what takes the run to
      // `safe_stopped` rather than leaving it in a recovery that cannot recover.
      Promise.reject(new Error('obs process launch is not configured (T17)')),
    obsConnectionAttempts: () => obsClient?.reconnectAttempts ?? 0,
  },
  onSafeStop: async () => {
    // Stop pushing to YouTube. The world keeps its state; leaving
    // `safe_stopped` is a human starting the process again (spec §9.2).
    await obsControl?.stopStream().catch(() => undefined)
  },
})

new KillSwitchFileWatcher({
  config: supervisorConfig.killSwitch,
  clock: systemClock,
  logger: stdoutLogger,
  onKill: (request) => {
    supervisor.onKillSwitch(request)
  },
}).start()

/**
 * Auth events go to two places at once (TASK_SPECS §T12 배선): T13 deletes the
 * data collected under the withdrawn consent (§12.4) and T12 stops the run,
 * because a revoked or unrenewable grant is outside the automation boundary
 * (§9.1). The sink is only built when there is a `TokenManager` to attach it to.
 */
const chatConfig = loadChatConfig()
let authEvents: AuthEventSink | undefined
if (chatConfig.enabled) {
  const authConfig = loadYouTubeAuthConfig()
  const vault = await resolveSecretVault({
    service: authConfig.credentialService,
    logger: stdoutLogger,
  })
  const revocation = new RevocationAuthEventSink({
    handler: new RevocationHandler({
      store,
      clock: systemClock,
      config: loadRetentionConfig(),
      grantRevoker: vaultGrantRevoker(vault),
      logger: stdoutLogger,
    }),
    onResult: (result) => {
      supervisor.onRevocationResult(result)
    },
    onError: (error) => {
      supervisor.onRetentionError(error)
    },
    logger: stdoutLogger,
  })
  authEvents = {
    emit: (event) => {
      revocation.emit(event)
      supervisor.onAuthEvent(event)
    },
  }
}

// The YouTube chat source waits for `engine.ready` on its own (spec §7.3(3)),
// so it can be built before the engine has finished its recovery drain.
chatSource = await createChatSource({
  store,
  inbox: { ingest: (envelopes, checkpoint) => engine.ingest(envelopes, checkpoint) },
  engine: {
    get ready() {
      return engine.ready
    },
    snapshot: () => engine.snapshot(),
  },
  clock: systemClock,
  inputConfig,
  identityGateOpen: config.engine.identityGateOpen,
  config: chatConfig,
  logger: stdoutLogger,
  ...(authEvents === undefined ? {} : { authEvents }),
  onIngested: () => {
    engine.pump()
  },
})

httpServer.listen(port, DEFAULT_HOST, () => {
  process.stdout.write(`@vl/server listening on http://${DEFAULT_HOST}:${port}\n`)
  // The listener is up first, so a renderer reconnecting during start-up finds
  // the socket and gets the recovery snapshot instead of a connection error.
  void supervisor.start()
})
