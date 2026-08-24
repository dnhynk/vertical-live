import type { CommandParser } from '@vl/contract'

import type { Clock } from '../../clock.js'
import type { SourceCheckpoint } from '../../db/types.js'
import type { InboxWriter } from '../../engine/ingest.js'
import type { HealthSignal, HealthSignalSink } from '../../health/types.js'
import { silentLogger, type Logger } from '../../secrets/redaction.js'
import type { QuotaTracker } from '../quota/tracker.js'
import type { ChatConfig } from './config.js'
import { GrpcChatSource, type GrpcStartPacingState } from './grpc-source.js'
import { buildChatHealthSignals, type ChatObservation } from './health.js'
import { RestChatSource } from './rest-source.js'
import { CancellableDelay, type ChatAccessTokens, type ChatRunResult } from './retry.js'
import { ChatIngestSink, type ConsentFailure, type ConsentObserver } from './sink.js'
import { ChatSourceState } from './state.js'
import {
  GrpcStreamListTransport,
  type GrpcTransportOptions,
  type StreamListTransport,
} from './transport.js'

/**
 * The YouTube chat source: gRPC `streamList` first, REST `list` as fallback,
 * one shared reconnect checkpoint, one set of health signals.
 *
 * Order of operations at start-up is fixed by spec §7.3(3): the engine drains
 * its inbox and only then declares itself `ready`. Receiving before that would
 * put new rows behind an unprocessed backlog, so this source waits.
 *
 * The path switch is deliberately dumb and reversible: `fallback.
 * enterAfterConsecutiveFailures` consecutive gRPC failures hand over to the
 * poller, and after `fallback.retryPrimaryAfterMs` the low-latency path is
 * tried again. Nothing about the switch resets the checkpoint, the reconnect
 * counters or the last user event — both paths are the same source (§9.4(3)).
 */

export interface LiveChatTarget {
  readonly liveChatId: string
  readonly broadcastId: string
}

/**
 * Where the `liveChatId` comes from. T10 persists it in `broadcast_resources`;
 * until that is wired the config value is the injection point TASK_SPECS §T9
 * allows.
 */
export type LiveChatTargetResolver = () => LiveChatTarget | null | Promise<LiveChatTarget | null>

export function configLiveChatTarget(config: ChatConfig): LiveChatTargetResolver {
  return () =>
    config.liveChatId === null || config.broadcastId === null
      ? null
      : { liveChatId: config.liveChatId, broadcastId: config.broadcastId }
}

export interface CheckpointReader {
  getSourceCheckpoint(sourceKey: string): SourceCheckpoint | null
}

export interface ChatSourceOptions {
  readonly config: ChatConfig
  readonly clock: Clock
  readonly inbox: InboxWriter
  readonly checkpoints: CheckpointReader
  readonly parseCommand: CommandParser
  readonly auth: ChatAccessTokens
  /** The engine gate of spec §7.3(3). */
  readonly engine: { readonly ready: boolean }
  readonly resolveTarget?: LiveChatTargetResolver
  readonly quota?: QuotaTracker
  readonly healthSink?: HealthSignalSink
  readonly onIngested?: (insertedCount: number) => void
  /** Consent directory; passed only while the consent gate is open (BOARD D-9). */
  readonly consent?: ConsentObserver
  /**
   * Notified for every consent decision the ingest path could not apply. The
   * source records it on its own health either way; this is the hook `main.ts`
   * uses to count it on `/metrics` too (review round 1, B3).
   */
  readonly onConsentFailure?: (failure: ConsentFailure) => void
  readonly logger?: Logger
  /** Replaced in tests by a transport pointed at the fake gRPC server. */
  readonly transport?: StreamListTransport
  readonly transportOptions?: Partial<GrpcTransportOptions>
  readonly fetchImpl?: typeof fetch
  readonly random?: () => number
}

export function chatSourceKey(liveChatId: string): string {
  return `youtube:${liveChatId}`
}

export class ChatSource {
  readonly #options: ChatSourceOptions
  readonly #state: ChatSourceState
  readonly #logger: Logger
  readonly #readyDelay: CancellableDelay
  /** Wakes the binding watcher; separate so stopping one does not stop the other. */
  readonly #targetWatch: CancellableDelay
  /** Retargeting creates a new gRPC reader, but not a new quota timeline. */
  readonly #grpcStartPacingState: GrpcStartPacingState = { lastStartedAtMonotonicMs: null }
  #retarget = false

  /** The chat this source is currently reading; `null` before it has one. */
  #target: LiveChatTarget | null = null
  #transport: StreamListTransport | undefined
  #sink: ChatIngestSink | undefined
  #grpc: GrpcChatSource | undefined
  #rest: RestChatSource | undefined
  #running: Promise<void> | undefined
  #cancelled = false
  #lastResult: ChatRunResult | null = null

  constructor(options: ChatSourceOptions) {
    this.#options = options
    this.#state = new ChatSourceState(
      options.clock,
      options.config.grpc.keepalive,
      options.consent !== undefined,
    )
    this.#logger = options.logger ?? silentLogger
    this.#readyDelay = new CancellableDelay(options.clock)
    this.#targetWatch = new CancellableDelay(options.clock)
  }

  /** Why the source stopped, once it has. */
  get lastResult(): ChatRunResult | null {
    return this.#lastResult
  }

  /** Health signals for `/health` and T12 (spec §9.4(3)). */
  signals(): HealthSignal[] {
    return buildChatHealthSignals(this.observe(), this.#options.clock)
  }

  observe(): ChatObservation {
    const channelState =
      this.#state.mode === 'grpc' && this.#grpc !== undefined ? this.#grpc.channelState() : null
    return this.#state.observe(
      this.#sink?.pageToken ?? null,
      channelState,
      this.#target?.liveChatId ?? null,
    )
  }

  /** Starts the source in the background. Idempotent. */
  start(): void {
    if (this.#running !== undefined) return
    this.#running = this.#run().catch((error: unknown) => {
      this.#logger.error('youtube chat: source loop failed', {
        error: (error as Error).message,
      })
      this.#state.recordStop('loop_failed')
      this.#emit()
    })
  }

  async stop(): Promise<void> {
    this.#cancelled = true
    this.#readyDelay.cancel()
    this.#targetWatch.cancel()
    this.#grpc?.stop()
    this.#rest?.stop()
    await this.#running
    this.#running = undefined
    this.#transport?.close()
    this.#transport = undefined
    this.#state.setMode('idle')
  }

  async #run(): Promise<void> {
    const { config } = this.#options
    if (!config.enabled) {
      this.#logger.info('youtube chat: disabled by config; not connecting')
      return
    }

    await this.#waitForEngine()
    if (this.#cancelled) return

    // One session per bound chat. A segment rollover replaces the broadcast and
    // with it the `liveChatId` (BOARD D-21, T33), and the listener has to follow
    // it — measured on 2026-08-23, where the source stayed on a broadcast two
    // swaps old, reconnecting to it 28 times, while `transport` reported `ok`
    // because the channel to that dead chat was `READY`.
    //
    // It follows the binding itself rather than being restarted into it: a
    // restart belongs to the supervisor (spec §9.2), and using one as the
    // re-target mechanism is what made two owners of the same component in T33.
    while (!this.#cancelled) {
      const target = await this.#resolveTarget()
      if (target === null) {
        this.#state.recordStop('no_live_chat_id')
        this.#emit()
        return
      }
      const outcome = await this.#runSession(target)
      if (outcome === 'stop') return
    }
  }

  /** Reads one chat until it ends, the paths give up, or the binding moves. */
  async #runSession(target: LiveChatTarget): Promise<'stop' | 'retarget'> {
    const { config } = this.#options

    const sourceKey = chatSourceKey(target.liveChatId)
    const stored = this.#options.checkpoints.getSourceCheckpoint(sourceKey)
    const sink = new ChatIngestSink({
      inbox: this.#options.inbox,
      clock: this.#options.clock,
      parseCommand: this.#options.parseCommand,
      sourceKey,
      liveChatId: target.liveChatId,
      broadcastId: target.broadcastId,
      initialPageToken: stored?.nextPageToken ?? null,
      ...(this.#options.onIngested === undefined ? {} : { onIngested: this.#options.onIngested }),
      ...(this.#options.consent === undefined
        ? {}
        : {
            consent: this.#options.consent,
            // One place both surfaces are fed from: the source's own health
            // signal and — through the caller's hook — `/metrics`.
            onConsentFailure: (failure: ConsentFailure): void => {
              this.#state.recordConsentFailure(failure)
              this.#logger.warn('youtube chat: a consent decision could not be applied', {
                kind: failure.kind,
                failClosed: failure.kind === 'withdrawal',
              })
              this.#options.onConsentFailure?.(failure)
            },
          }),
    })
    this.#sink = sink
    this.#logger.info('youtube chat: starting', {
      liveChatId: target.liveChatId,
      resumed: stored?.nextPageToken !== undefined && stored?.nextPageToken !== null,
    })

    this.#transport =
      this.#options.transport ??
      new GrpcStreamListTransport({
        endpoint: config.grpc.endpoint,
        keepalive: config.grpc.keepalive,
        ...this.#options.transportOptions,
      })

    const grpc = new GrpcChatSource({
      transport: this.#transport,
      sink,
      state: this.#state,
      clock: this.#options.clock,
      config,
      auth: this.#options.auth,
      liveChatId: target.liveChatId,
      startPacingState: this.#grpcStartPacingState,
      logger: this.#logger,
      ...(this.#options.quota === undefined ? {} : { quota: this.#options.quota }),
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
    })
    this.#grpc = grpc
    const rest = new RestChatSource({
      sink,
      state: this.#state,
      clock: this.#options.clock,
      config,
      auth: this.#options.auth,
      liveChatId: target.liveChatId,
      logger: this.#logger,
      ...(this.#options.quota === undefined ? {} : { quota: this.#options.quota }),
      ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
    })

    this.#rest = rest

    this.#target = target
    // The gRPC loop reconnects on its own and does not return between
    // connections, so a check placed after it would never run while the path is
    // healthy. A watcher polls the binding instead and cancels the running path
    // the moment it moves; the loop below then sees the change and re-targets.
    const watching = this.#watchTarget(target)
    let usePrimary = true
    while (!this.#cancelled) {
      const result: ChatRunResult = usePrimary ? await grpc.run() : await rest.run()
      this.#lastResult = result
      this.#emit()
      // The binding may have moved while that path was running. Checked here
      // rather than on a timer: this is the moment the source is between
      // connections and can change target without dropping one.
      if (this.#retarget) {
        this.#retarget = false
        this.#state.clearStop()
        this.#targetWatch.cancel()
        await watching
        return 'retarget'
      }
      if (result.outcome === 'stopped' || result.outcome === 'cancelled') {
        this.#logger.warn('youtube chat: source stopped', { reason: result.reason })
        return 'stop'
      }
      // `fallback` (gRPC gave up) and `switch_back` (REST's turn is over) are
      // the two halves of the same switch.
      usePrimary = result.outcome === 'switch_back'
      this.#logger.info('youtube chat: switching path', {
        to: usePrimary ? 'grpc' : 'rest',
        reason: result.reason,
      })
    }
    this.#targetWatch.cancel()
    await watching
    return 'stop'
  }

  /**
   * Follows the binding while one chat is being read. It only ever *cancels* the
   * running path — the session loop decides what to do next, so there is one
   * place where a target change turns into a new session.
   */
  async #watchTarget(current: LiveChatTarget): Promise<void> {
    while (!this.#cancelled && !this.#retarget) {
      await this.#targetWatch.wait(this.#options.config.readyPollIntervalMs)
      if (this.#cancelled) return
      const bound = await this.#resolveTarget()
      if (bound === null || bound.liveChatId === current.liveChatId) continue
      this.#logger.info('youtube chat: the bound chat changed; following it', {
        from: current.broadcastId,
        to: bound.broadcastId,
      })
      this.#retarget = true
      this.#grpc?.stop()
      this.#rest?.stop()
      return
    }
  }

  async #resolveTarget(): Promise<LiveChatTarget | null> {
    const resolver = this.#options.resolveTarget ?? configLiveChatTarget(this.#options.config)
    const target = await resolver()
    if (target === null) {
      this.#logger.warn(
        'youtube chat: no liveChatId available (config youtube.chat.liveChatId or T10 broadcast_resources); staying idle',
      )
    }
    return target
  }

  async #waitForEngine(): Promise<void> {
    while (!this.#cancelled && !this.#options.engine.ready) {
      await this.#readyDelay.wait(this.#options.config.readyPollIntervalMs)
    }
  }

  #emit(): void {
    const sink = this.#options.healthSink
    if (sink === undefined) return
    for (const signal of this.signals()) sink(signal)
  }
}
