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
import { ObsProcessLauncher } from './obs/process.js'
import { SecretRedactor, type LogFields, type Logger } from './secrets/redaction.js'
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
import { classifyStoreFailure } from './supervisor/db-integrity.js'
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
import { loadOAuthClientCredentials, loadYouTubeAuthConfig } from './youtube/auth/config.js'
import { OAuthClient } from './youtube/auth/oauth-client.js'
import { TokenManager } from './youtube/auth/token-manager.js'
import { YouTubeLiveApi } from './youtube/broadcast/api.js'
import { loadBroadcastConfig } from './youtube/broadcast/config.js'
import { BroadcastHealthMonitor } from './youtube/broadcast/health.js'
import { BroadcastLifecycle, type BroadcastBinding } from './youtube/broadcast/lifecycle.js'
import { StreamKeyCustodian } from './youtube/broadcast/stream-key.js'
import type { ChatSource } from './youtube/chat/chat-source.js'
import { loadChatConfig } from './youtube/chat/config.js'
import { createChatSource } from './youtube/chat/runtime.js'
import { createExponentialBackoff } from './youtube/quota/backoff.js'
import { loadQuotaConfig } from './youtube/quota/config.js'
import { QuotaTracker } from './youtube/quota/tracker.js'

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

const secrets = defaultSecretProvider()

// ------------------------------------------------------------------ alerts
//
// Built before the store, so the one failure that happens *before* a supervisor
// can exist still reaches a human (review round 1, M3). Opening the database is
// the first thing that can fail on a damaged host, and §11 asks for an alert on
// exactly that class of failure.

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

/**
 * The database is the authority (spec §10.2), so a store that cannot be opened
 * is not a start-up that continues. A damaged file or an unverifiable migration
 * history is §11's data-integrity condition: it is reported as a `safe_stopped`
 * alert and the process exits instead of dying with a stack trace nobody sees.
 * Once the supervisor exists, the same classification runs inside the `state`
 * pre-check and produces the real `safe_stopped` state (`runtime.ts`).
 */
async function openStoreOrStop(): Promise<PersistenceStore> {
  try {
    return PersistenceStore.fromConfig({ clock: systemClock })
  } catch (error) {
    const failure = classifyStoreFailure(error)
    stdoutLogger.error('database unavailable at start-up', {
      integrity: failure.integrity,
      reason: failure.reason,
    })
    await alerts.deliver({
      kind: failure.integrity ? 'supervisor.safe_stopped' : 'store.unavailable',
      severity: 'critical',
      at: systemClock.nowUtcIso(),
      reason: failure.integrity ? `data_integrity:${failure.reason}` : failure.reason,
      detail: { phase: 'startup', integrity: failure.integrity },
    })
    // No automatic restart: a data-integrity stop is a human decision (§9.1).
    process.exitCode = 1
    throw error
  }
}

const store = await openStoreOrStop()

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

// --------------------------------------------------------------------- OBS

let obsClient: ObsClient | null = null
let obsControl: ObsControl | null = null
let obsPort: ObsPort | null = null
/** T17's Windows launcher for the `obs-process` component; null until wired. */
let obsLauncher: ObsProcessLauncher | null = null
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
      // Both runtime injections happen in this step because they are the same
      // custody act (BOARD A-16): the vault holds the renderer token and the
      // stream key, and OBS is given them at start rather than an operator
      // typing them in. The renderer URL goes first — the page has to be
      // loading before the `renderer` pre-check can pass (T17).
      await control.setRendererSourceFromVault()
      return control.setStreamServiceFromVault()
    },
    startStream: () => control.startStream(),
  }
  obsLauncher = new ObsProcessLauncher({
    config: obsConfig.process,
    logger: stdoutLogger,
  })
}

// --------------------------------------------------------- YouTube (T3/T10)

/**
 * One `TokenManager` for the whole process. The chat source (T9) and the
 * broadcast lifecycle (T10) share it: two managers on one grant would both
 * refresh and rotate the same refresh token.
 *
 * Auth events go to two places at once (TASK_SPECS §T12 배선): T13 deletes the
 * data collected under the withdrawn consent (§12.4) and T12 stops the run,
 * because a revoked or unrenewable grant is outside the automation boundary
 * (§9.1).
 */
const chatConfig = loadChatConfig()
const needsGrant = chatConfig.enabled || supervisorConfig.integrations.broadcast

let tokens: TokenManager | null = null
let broadcastPort: BroadcastPort | null = null
let broadcastLifecycle: BroadcastLifecycle | null = null

if (needsGrant) {
  const authConfig = loadYouTubeAuthConfig()
  const credentials = loadOAuthClientCredentials()
  const redactor = new SecretRedactor()
  redactor.register(credentials.clientSecret)
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

  tokens = new TokenManager({
    client: new OAuthClient({
      clientId: credentials.clientId,
      ...(credentials.clientSecret === undefined ? {} : { clientSecret: credentials.clientSecret }),
      clock: systemClock,
    }),
    vault,
    clock: systemClock,
    refreshSkewMs: authConfig.accessTokenRefreshSkewMs,
    logger: stdoutLogger,
    redactor,
    events: {
      emit: (event) => {
        revocation.emit(event)
        supervisor.onAuthEvent(event)
      },
    },
  })

  if (supervisorConfig.integrations.broadcast) {
    const broadcastConfig = loadBroadcastConfig()
    const quotaConfig = loadQuotaConfig()
    const custodian = new StreamKeyCustodian({ vault, redactor, logger: stdoutLogger })
    const api = new YouTubeLiveApi({
      tokens,
      clock: systemClock,
      requestTimeoutMs: broadcastConfig.requestTimeoutMs,
      // The custodian owns the key between the API response and the vault write;
      // the API client keeps no copy (BOARD A-16).
      streamKeySink: custodian.sink,
      quota: new QuotaTracker({
        clock: systemClock,
        dailyUnits: quotaConfig.dailyUnits,
        reserveUnits: quotaConfig.reserveUnits,
        timeZone: quotaConfig.resetTimeZone,
      }),
      logger: stdoutLogger,
      redactor,
    })
    const lifecycle = new BroadcastLifecycle({
      api,
      store,
      config: broadcastConfig,
      clock: systemClock,
      backoff: createExponentialBackoff({
        initialDelayMs: quotaConfig.backoff.initialDelayMs,
        maxDelayMs: quotaConfig.backoff.maxDelayMs,
        factor: quotaConfig.backoff.factor,
        jitterRatio: quotaConfig.backoff.jitterRatio,
        maxAttempts: quotaConfig.backoff.maxAttempts,
      }),
      streamKeys: custodian,
      alerts: (alert) => {
        stdoutLogger.info('broadcast alert', { kind: alert.kind, reason: alert.reason })
      },
      // Spec §9.1: a limit the lifecycle cannot recover from is a `safe_stopped`.
      safeStop: (request) => {
        supervisor.onBroadcastSafeStopRequest(request)
      },
      logger: stdoutLogger,
    })
    broadcastLifecycle = lifecycle

    let binding: BroadcastBinding | null = null
    new BroadcastHealthMonitor({
      api,
      config: broadcastConfig,
      clock: systemClock,
      resources: () => ({
        streamId: binding?.streamId ?? null,
        broadcastId: binding?.broadcastId ?? null,
      }),
      onSignal: (signal) => {
        supervisor.report(signal)
      },
    }).start()

    broadcastPort = {
      ensureBound: async () => {
        binding = await lifecycle.ensureBound()
        return { broadcastId: binding.broadcastId, liveChatId: binding.liveChatId }
      },
      goLive: async () => {
        binding = await lifecycle.goLive()
      },
      publish: () => lifecycle.publish(),
      bound: () => binding !== null,
      // Spec §9.1 keeps 최초 공개 with the operator: while the configured privacy
      // is `private` there is nothing to publish (BOARD A-18).
      publishable: () => broadcastConfig.privacyStatus !== 'private',
    }
  }
}

// ------------------------------------------------------------- supervisor

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
  clock: systemClock,
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
  // Null when `youtube.chat.enabled` is false — a deployment posture, reported as
  // `not_configured` like OBS and broadcast. When chat *is* configured the port
  // must not paper over a missing source: a start-up step that succeeded while
  // no listener existed is what let the run go live without an input path
  // (review round 1, B2).
  chat: chatConfig.enabled
    ? {
        start: () => {
          if (chatSource === null) {
            throw new Error(
              'youtube.chat.enabled is true but no chat source was created; check the OAuth client credentials and the vault',
            )
          }
          chatSource.start()
        },
        // Running, not merely constructed (review round 2): a path has been
        // selected (`mode` left `idle`) and the loop has not given up. Both are
        // T9's own state, so this cannot drift from what the source reports on
        // `/health`.
        started: () => {
          if (chatSource === null) return false
          const observation = chatSource.observe()
          return observation.stopped === null && observation.mode !== 'idle'
        },
      }
    : null,
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
    // Two-phase, so it is the action that has to re-check: stopping the source
    // awaits, and by the time it returns the run may have entered
    // `safe_stopped`. Starting a listener after that is exactly the automatic
    // restart §9.1/§9.2 forbid (review round 3).
    chatSource: async (signal) => {
      await chatSource?.stop()
      if (signal.aborted) return
      chatSource?.start()
    },
    obsStream: async (signal) => {
      if (obsControl === null) throw new Error('obs integration is not configured')
      if (signal.aborted) return
      await obsControl.startStream()
    },
    rendererSource: async (signal) => {
      if (obsControl === null) throw new Error('obs integration is not configured')
      if (signal.aborted) return
      await obsControl.refreshBrowserSource()
    },
    obsProcess: (signal) => {
      // T17's launcher. It refuses when it is not configured, when the
      // executable is missing and when OBS is already running, so an escalation
      // that cannot actually recover still fails honestly and the run reaches
      // `safe_stopped` instead of a recovery that cannot recover.
      if (obsLauncher === null) {
        return Promise.reject(
          new Error('obs process launch is not configured (obs integration off)'),
        )
      }
      if (signal.aborted) return Promise.resolve()
      const launched = obsLauncher.launch()
      // BOARD D-7: the launcher empties OBS's crash sentinel before spawning, so
      // an unattended restart is not met by the Safe Mode dialog (which disables
      // obs-websocket). The count goes onto the component the supervisor already
      // reports, because a clearing that keeps finding files is a crash loop the
      // operator has to see — the dialog is hidden, the fault is not.
      supervisor.noteComponent(
        'obs-process',
        launched.sentinelFailure === null
          ? `sentinel_cleared=${String(launched.sentinelCleared)}`
          : `sentinel_cleared=${String(launched.sentinelCleared)} sentinel_failure=${launched.sentinelFailure}`,
      )
      return Promise.resolve()
    },
    obsConnectionAttempts: () => obsClient?.reconnectAttempts ?? 0,
  },
  onSafeStop: async () => {
    // Stop pushing to YouTube. The world keeps its state; leaving
    // `safe_stopped` is a human starting the process again (spec §9.2).
    await obsControl?.stopStream().catch(() => undefined)
    // Then take the two injected secrets back out of OBS (BOARD A-16, T17):
    // OBS persists the stream key into the profile's `service.json` and the
    // renderer token into the scene-collection JSON, and a stopped run has no
    // reason to leave either on disk. Best effort — a failure here must not
    // stand between the run and its stop.
    await obsControl?.clearStreamServiceKey().catch(() => undefined)
    await obsControl?.clearRendererSourceToken().catch(() => undefined)
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
 * The chat source waits for `engine.ready` on its own (spec §7.3(3)), so it can
 * be built before the engine has finished its recovery drain. Its `liveChatId`
 * comes from the open attempt in `broadcast_resources` when the lifecycle is
 * wired; the config value stays as the development injection point §T9 allows.
 */
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
  ...(tokens === null ? {} : { auth: tokens }),
  ...(broadcastLifecycle === null
    ? {}
    : {
        resolveTarget: async () => {
          const binding = await broadcastLifecycle.ensureBound()
          return binding.liveChatId === null
            ? null
            : { liveChatId: binding.liveChatId, broadcastId: binding.broadcastId }
        },
      }),
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
