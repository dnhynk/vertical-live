import type { CommandParser } from '@vl/contract'

import type { Clock } from '../../clock.js'
import type { SourceCheckpoint } from '../../db/types.js'
import type { InboxWriter } from '../../engine/ingest.js'
import type { HealthSignal, HealthSignalSink } from '../../health/types.js'
import { silentLogger, type Logger } from '../../secrets/redaction.js'
import type { QuotaTracker } from '../quota/tracker.js'
import type { ChatConfig } from './config.js'
import { GrpcChatSource } from './grpc-source.js'
import { buildChatHealthSignals, type ChatObservation } from './health.js'
import { RestChatSource } from './rest-source.js'
import { CancellableDelay, type ChatAccessTokens, type ChatRunResult } from './retry.js'
import { ChatIngestSink } from './sink.js'
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

  #transport: StreamListTransport | undefined
  #sink: ChatIngestSink | undefined
  #grpc: GrpcChatSource | undefined
  #rest: RestChatSource | undefined
  #running: Promise<void> | undefined
  #cancelled = false
  #lastResult: ChatRunResult | null = null

  constructor(options: ChatSourceOptions) {
    this.#options = options
    this.#state = new ChatSourceState(options.clock, options.config.grpc.keepalive)
    this.#logger = options.logger ?? silentLogger
    this.#readyDelay = new CancellableDelay(options.clock)
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
    return this.#state.observe(this.#sink?.pageToken ?? null, channelState)
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

    const target = await this.#resolveTarget()
    if (target === null) {
      this.#state.recordStop('no_live_chat_id')
      this.#emit()
      return
    }

    await this.#waitForEngine()
    if (this.#cancelled) return

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

    let usePrimary = true
    while (!this.#cancelled) {
      const result: ChatRunResult = usePrimary ? await grpc.run() : await rest.run()
      this.#lastResult = result
      this.#emit()
      if (result.outcome === 'stopped' || result.outcome === 'cancelled') {
        this.#logger.warn('youtube chat: source stopped', { reason: result.reason })
        return
      }
      // `fallback` (gRPC gave up) and `switch_back` (REST's turn is over) are
      // the two halves of the same switch.
      usePrimary = result.outcome === 'switch_back'
      this.#logger.info('youtube chat: switching path', {
        to: usePrimary ? 'grpc' : 'rest',
        reason: result.reason,
      })
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
