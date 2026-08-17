import { readRendererConfig, type RendererConfig } from './config'
import { createAlias, createTranslator, type Alias, type Translate } from './i18n/index'
import { systemClock, type Clock } from './read-model/clock'
import {
  RendererConnection,
  type Timers as ConnectionTimers,
  type WebSocketLike,
} from './read-model/connection'
import {
  FrameLoop,
  RendererHealth,
  WebGlContextTracker,
  type FrameScheduler,
  type Timers as HealthTimers,
} from './read-model/health'
import { RendererLog } from './read-model/log'
import { ReadModel } from './read-model/store'

/**
 * Wires the read model, the WebSocket client and the health sources together.
 *
 * Everything injectable is injected here, so a test builds the same runtime the
 * browser builds with a fake socket, a fake frame scheduler and a fake clock.
 */
export interface RendererRuntime {
  readonly config: RendererConfig
  readonly clock: Clock
  readonly log: RendererLog
  readonly model: ReadModel
  readonly connection: RendererConnection
  readonly frameLoop: FrameLoop
  readonly webgl: WebGlContextTracker
  readonly health: RendererHealth
  readonly translate: Translate
  /** Short English alias shown after the Japanese wording (spec §5.1). */
  readonly alias: Alias
  start(): void
  stop(): void
}

export interface CreateRuntimeOptions {
  /** `window.location.search` in the browser. */
  search: string
  clock?: Clock
  socketFactory?: (url: string) => WebSocketLike
  frameScheduler?: FrameScheduler
  timers?: ConnectionTimers & HealthTimers
  random?: () => number
  generateRendererId?: () => string
  effectRetentionMs?: number
  maxRememberedEffects?: number
  webglRestoreDelayMs?: number
}

export function createRuntime(options: CreateRuntimeOptions): RendererRuntime {
  const clock = options.clock ?? systemClock
  const log = new RendererLog(clock)
  const config = readRendererConfig({
    search: options.search,
    log,
    generateRendererId: options.generateRendererId,
  })
  const translate = createTranslator(log)
  const alias = createAlias()

  const model = new ReadModel({
    clock,
    log,
    effectRetentionMs: options.effectRetentionMs,
    maxRememberedEffects: options.maxRememberedEffects,
  })

  const frameLoop = new FrameLoop({
    clock,
    scheduler: options.frameScheduler,
    onFrame: () => {
      model.markFramePresented()
    },
  })

  const webgl = new WebGlContextTracker({
    log,
    timers: options.timers,
    restoreDelayMs: options.webglRestoreDelayMs,
  })

  const health = new RendererHealth(frameLoop, webgl)

  const connection = new RendererConnection({
    url: config.wsUrl,
    rendererId: config.rendererId,
    model,
    health,
    clock,
    log,
    backoff: config.backoff,
    healthIntervalMs: config.healthIntervalMs,
    random: options.random,
    socketFactory: options.socketFactory,
    timers: options.timers,
  })

  return {
    config,
    clock,
    log,
    model,
    connection,
    frameLoop,
    webgl,
    health,
    translate,
    alias,
    start() {
      frameLoop.start()
      connection.start()
      log.info('renderer_started', config.mode)
    },
    stop() {
      connection.stop()
      frameLoop.stop()
      webgl.detach()
    },
  }
}
