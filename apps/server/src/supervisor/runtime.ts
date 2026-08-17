import type { EngineHealth } from '../engine/engine.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { SecretName, SecretProvider } from '../secrets/types.js'
import type { SupervisorConfig } from './config.js'
import { PREFLIGHT_OK, type PreflightOutcome, type PreflightProbes } from './preflight.js'
import type { StartupSteps } from './startup.js'

/**
 * Composition of the start-up sequence and the `starting` pre-checks over
 * **ports** rather than concrete modules.
 *
 * `main.ts` builds the real adapters (T2 OBS, T3 auth, T8 engine, T9 chat, T10
 * broadcast, T13 retention); everything about *what runs when* lives here, where
 * it can be tested with fakes and without a network, an OBS install or a Google
 * account.
 *
 * A port that is `null` means "this deployment has not configured it". That is
 * not treated as success: the step is skipped with a log line **and** the
 * matching pre-check fails with `not_configured`, so a host without YouTube
 * credentials keeps its world running (spec §2.1) and stays in `starting`
 * instead of reporting a broadcast it never made.
 */

export interface EnginePort {
  start(): void
  readonly ready: boolean
  health(): EngineHealth
}

export interface RetentionPort {
  start(): void
}

export interface BroadcastPort {
  ensureBound(): Promise<{ readonly broadcastId: string; readonly liveChatId: string | null }>
  goLive(): Promise<unknown>
  publish(): Promise<unknown>
  /** True once `ensureBound()` has produced a binding in this process. */
  bound(): boolean
  /** False while `youtube.broadcast.privacyStatus` is `private` (spec §9.1). */
  publishable(): boolean
}

export interface ObsPort {
  connected(): boolean
  setStreamServiceFromVault(): Promise<unknown>
  startStream(): Promise<unknown>
}

export interface ChatPort {
  start(): void
}

export interface RuntimeDeps {
  readonly config: SupervisorConfig
  readonly engine: EnginePort
  /** Opens the database and applies migrations; throws when it cannot. */
  readonly openStore: () => void
  readonly retention: RetentionPort | null
  readonly broadcast: BroadcastPort | null
  readonly obs: ObsPort | null
  readonly chat: ChatPort | null
  readonly logger?: Logger
}

export function buildStartupSteps(deps: RuntimeDeps): StartupSteps {
  const logger = deps.logger ?? silentLogger
  const skip = (step: string, why: string): void => {
    logger.warn('startup step skipped', { step, reason: why })
  }

  return {
    db: () => {
      deps.openStore()
    },
    engine: () => {
      deps.engine.start()
      if (!deps.engine.ready) {
        // §7.3(3): nothing downstream may run before recovery has finished.
        throw new Error('engine did not become ready')
      }
    },
    retention: () => {
      if (deps.retention === null) {
        skip('retention', 'not_configured')
        return
      }
      deps.retention.start()
    },
    broadcast: async () => {
      if (deps.broadcast === null) {
        skip('broadcast', 'not_configured')
        return
      }
      await deps.broadcast.ensureBound()
    },
    streamService: async () => {
      if (deps.obs === null) {
        skip('streamService', 'not_configured')
        return
      }
      // BOARD A-16: the vault is the stream key's system of record and the key
      // is injected at runtime, before the output starts.
      await deps.obs.setStreamServiceFromVault()
    },
    startStream: async () => {
      if (deps.obs === null) {
        skip('startStream', 'not_configured')
        return
      }
      await deps.obs.startStream()
    },
    goLive: async () => {
      if (deps.broadcast === null) {
        skip('goLive', 'not_configured')
        return
      }
      await deps.broadcast.goLive()
    },
    chatSource: () => {
      if (deps.chat === null) {
        skip('chatSource', 'not_configured')
        return
      }
      deps.chat.start()
    },
    publish: async () => {
      if (deps.broadcast === null) {
        skip('publish', 'not_configured')
        return
      }
      if (!deps.broadcast.publishable()) {
        // Spec §9.1 leaves 최초 공개 with the operator; a `private` broadcast is
        // the configured outcome, not a failure.
        skip('publish', 'privacy_status_private')
        return
      }
      await deps.broadcast.publish()
    },
  }
}

export interface PreflightDeps extends RuntimeDeps {
  readonly secrets: SecretProvider
}

/**
 * The six §9.2 pre-checks over the same ports. Each answers one question with a
 * machine-stable reason, and only the ones a retry cannot fix carry a
 * `safeStop` (spec §9.1).
 */
export function buildPreflightProbes(deps: PreflightDeps): PreflightProbes {
  return {
    credentials: async () => {
      if (deps.broadcast === null) return notConfigured('broadcast')
      // The broadcast port only answers `bound()` after a call that needed a
      // token, so a binding is proof the grant worked. A revoked grant surfaces
      // through T3's `AuthEventSink`, which stops the run on its own.
      return deps.broadcast.bound()
        ? PREFLIGHT_OK
        : { passed: false, reason: 'no_binding_yet' }
    },
    secrets: async () => {
      const required: SecretName[] = ['server.rendererToken', 'server.adminToken']
      if (deps.obs !== null) required.push('youtube.streamKey')
      if (deps.config.alerts.discordEnabled) required.push('alerts.discordWebhookUrl')
      if (deps.config.deadMan.enabled) required.push('monitoring.deadManPushUrl')

      const missing: string[] = []
      for (const name of required) {
        const value = await deps.secrets.get(name)
        if (value === undefined || value === '') missing.push(name)
      }
      // Names, never values (spec §10.2).
      return missing.length === 0
        ? PREFLIGHT_OK
        : { passed: false, reason: `missing:${missing.join('+')}` }
    },
    state: () =>
      deps.engine.ready ? PREFLIGHT_OK : { passed: false, reason: 'engine_not_ready' },
    api: () => {
      if (deps.broadcast === null) return notConfigured('broadcast')
      return deps.broadcast.bound() ? PREFLIGHT_OK : { passed: false, reason: 'not_bound' }
    },
    renderer: () =>
      deps.engine.health().rendererCount > 0
        ? PREFLIGHT_OK
        : { passed: false, reason: 'no_renderer_attached' },
    encoder: () => {
      if (deps.obs === null) return notConfigured('obs')
      return deps.obs.connected() ? PREFLIGHT_OK : { passed: false, reason: 'obs_not_connected' }
    },
  }
}

function notConfigured(what: string): PreflightOutcome {
  return { passed: false, reason: `not_configured:${what}` }
}
