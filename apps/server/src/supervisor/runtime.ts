import type { Clock } from '../clock.js'
import type { EngineHealth } from '../engine/engine.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { SecretName, SecretProvider } from '../secrets/types.js'
import type { SupervisorConfig } from './config.js'
import { classifyStoreFailure } from './db-integrity.js'
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
  /**
   * Replaces the running broadcast when its segment is over, and answers with
   * the new binding (BOARD D-21, TASK_SPECS §T33). `null` means nothing was due,
   * which is every tick while `youtube.broadcast.segmentMs` is off.
   */
  rolloverIfDue?(): Promise<{
    readonly broadcastId: string
    readonly liveChatId: string | null
  } | null>
}

export interface ObsPort {
  connected(): boolean
  setStreamServiceFromVault(): Promise<unknown>
  startStream(): Promise<unknown>
}

export interface ChatPort {
  start(): void
  /**
   * True only when the canonical chat transport readiness signal is `ok`.
   * Selecting a path is not enough: T51 measured a source in gRPC pacing with
   * its previous failure verdict still active while restart attempts burned.
   */
  started(): boolean
}

export interface RestartableChatPort extends ChatPort {
  stop(): Promise<void>
}

export interface ChatReadinessWaitOptions {
  readonly chat: ChatPort
  readonly clock: Clock
  readonly timeoutMs: number
  readonly pollIntervalMs: number
  readonly cancelled: () => boolean
  readonly signal?: AbortSignal
}

export interface RestartChatSourceOptions {
  readonly chat: RestartableChatPort
  readonly clock: Clock
  readonly timeoutMs: number
  readonly pollIntervalMs: number
  readonly signal: AbortSignal
}

export interface RuntimeDeps {
  readonly config: SupervisorConfig
  /** Injected so the chat step's bounded wait is testable (spec §10.2). */
  readonly clock: Clock
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
    // Every step from here on reaches YouTube or OBS, so each one asks whether
    // the run is still going before it does (review round 3). The sequence asks
    // the same question around each await; this is the inner half of that guard.
    broadcast: async (context) => {
      if (deps.broadcast === null) {
        skip('broadcast', 'not_configured')
        return
      }
      if (context.cancelled()) return
      await deps.broadcast.ensureBound()
    },
    streamService: async (context) => {
      if (deps.obs === null) {
        skip('streamService', 'not_configured')
        return
      }
      if (context.cancelled()) return
      // BOARD A-16: the vault is the system of record for what OBS is given at
      // runtime — the renderer token and the stream key — and both go in before
      // the output starts. `main.ts` supplies the adapter that does it (T17).
      await deps.obs.setStreamServiceFromVault()
    },
    startStream: async (context) => {
      if (deps.obs === null) {
        skip('startStream', 'not_configured')
        return
      }
      if (context.cancelled()) return
      await deps.obs.startStream()
    },
    goLive: async (context) => {
      if (deps.broadcast === null) {
        skip('goLive', 'not_configured')
        return
      }
      if (context.cancelled()) return
      await deps.broadcast.goLive()
    },
    chatSource: async (context) => {
      if (deps.chat === null) {
        skip('chatSource', 'not_configured')
        return
      }
      if (context.cancelled()) return
      deps.chat.start()
      // A step that "succeeded" without a source running is what let a
      // configured chat disappear silently (review round 1, B2). Round 2 found
      // the check too weak: it asked whether the *object* existed. Starting is a
      // background job — resolve the `liveChatId`, dial gRPC, fall back to REST —
      // so the step waits for the transport's canonical positive readiness and
      // fails the sequence if it never arrives.
      await waitForChatSourceReady({
        chat: deps.chat,
        clock: deps.clock,
        timeoutMs: deps.config.chatStart.timeoutMs,
        pollIntervalMs: deps.config.chatStart.pollIntervalMs,
        cancelled: context.cancelled,
      })
    },
    publish: async (context) => {
      if (deps.broadcast === null) {
        skip('publish', 'not_configured')
        return
      }
      if (context.cancelled()) return
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

/**
 * Restarts chat and keeps the supervisor attempt in flight until the input path
 * is positively ready (T51). A `start()` call only launches a background loop;
 * returning there let the 2026-08-27 public pilot spend attempts 1/2/3 in 13s
 * while T47 pacing still prevented a new stream from opening.
 */
export async function restartChatSource(options: RestartChatSourceOptions): Promise<void> {
  await options.chat.stop()
  if (options.signal.aborted) return
  options.chat.start()
  await waitForChatSourceReady({
    chat: options.chat,
    clock: options.clock,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    cancelled: () => options.signal.aborted,
    signal: options.signal,
  })
}

/** T47's maximum pacing wait plus the existing readiness window, no new knob. */
export function chatRestartReadinessTimeoutMs(
  chatStartTimeoutMs: number,
  grpcStreamMinStartIntervalMs: number,
): number {
  const timeoutMs = chatStartTimeoutMs + grpcStreamMinStartIntervalMs
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new RangeError('chat restart readiness timeout exceeds Number.MAX_SAFE_INTEGER')
  }
  return timeoutMs
}

export async function waitForChatSourceReady(options: ChatReadinessWaitOptions): Promise<void> {
  const deadlineMs = options.clock.monotonicMs() + options.timeoutMs
  for (;;) {
    if (options.cancelled()) return
    if (options.chat.started()) return
    const remainingMs = deadlineMs - options.clock.monotonicMs()
    if (remainingMs <= 0) {
      throw new Error(
        `chat source did not become ready within ${options.timeoutMs}ms; the configured input path (spec §9.4(3)) is not running`,
      )
    }
    await sleep(options.clock, Math.min(options.pollIntervalMs, remainingMs), options.signal)
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
      return deps.broadcast.bound() ? PREFLIGHT_OK : { passed: false, reason: 'no_binding_yet' }
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
    state: () => {
      // The store is asked first, and its failure is *classified*: a damaged
      // file or an unverifiable migration history is §11's data-integrity stop,
      // not something to retry `starting` over (review round 1, M3). Everything
      // else — a busy lock, a full disk — stays a plain retryable failure.
      try {
        deps.openStore()
      } catch (error) {
        const failure = classifyStoreFailure(error)
        return {
          passed: false,
          reason: `store:${failure.reason}`,
          ...(failure.integrity ? { safeStop: 'data_integrity' as const } : {}),
        }
      }
      return deps.engine.ready ? PREFLIGHT_OK : { passed: false, reason: 'engine_not_ready' }
    },
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

async function sleep(clock: Clock, delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    let settled = false
    function finish(): void {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      clock.clearTimeout(timer)
      finish()
    }
    const timer = clock.setTimeout(finish, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function notConfigured(what: string): PreflightOutcome {
  return { passed: false, reason: `not_configured:${what}` }
}
