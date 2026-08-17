import type { Clock } from './clock.js'
import type { RendererLog } from './log.js'

/**
 * Renderer health signals of spec §9.4(4): frame counter, FPS and WebGL
 * context state. The frame loop is also what releases ACKs, so a renderer that
 * stops painting stops acknowledging and the server can see it (spec §9.2).
 */

export interface HealthSource {
  readonly frameCounter: number
  readonly fps: number
  readonly webglContextLost: boolean
}

export interface FrameScheduler {
  request(callback: () => void): number
  cancel(handle: number): void
}

export const animationFrameScheduler: FrameScheduler = {
  request: (callback) => globalThis.requestAnimationFrame(() => callback()),
  cancel: (handle) => {
    globalThis.cancelAnimationFrame(handle)
  },
}

export interface FrameLoopOptions {
  clock: Clock
  onFrame: () => void
  scheduler?: FrameScheduler
  /** How many frame timestamps the FPS average is taken over. */
  fpsWindowFrames?: number
}

/** Provisional (BOARD A-15): no spec value. */
export const DEFAULT_FPS_WINDOW_FRAMES = 120

/**
 * `requestAnimationFrame` loop. The HTML standard runs these callbacks in the
 * "update the rendering" step, just before the repaint, so a callback observing
 * a committed render is evidence that the frame carrying it is being painted.
 */
export class FrameLoop {
  readonly #clock: Clock
  readonly #onFrame: () => void
  readonly #scheduler: FrameScheduler
  readonly #windowFrames: number
  readonly #timestamps: number[] = []

  #handle: number | null = null
  #frameCounter = 0

  constructor(options: FrameLoopOptions) {
    this.#clock = options.clock
    this.#onFrame = options.onFrame
    this.#scheduler = options.scheduler ?? animationFrameScheduler
    this.#windowFrames = options.fpsWindowFrames ?? DEFAULT_FPS_WINDOW_FRAMES
  }

  get frameCounter(): number {
    return this.#frameCounter
  }

  /** Frames per second over the sampling window; `0` before the second frame. */
  get fps(): number {
    if (this.#timestamps.length < 2) return 0
    const first = this.#timestamps[0] as number
    const last = this.#timestamps[this.#timestamps.length - 1] as number
    const elapsedMs = last - first
    if (elapsedMs <= 0) return 0
    return ((this.#timestamps.length - 1) * 1000) / elapsedMs
  }

  get running(): boolean {
    return this.#handle !== null
  }

  start(): void {
    if (this.#handle !== null) return
    this.#schedule()
  }

  stop(): void {
    if (this.#handle === null) return
    this.#scheduler.cancel(this.#handle)
    this.#handle = null
  }

  #schedule(): void {
    this.#handle = this.#scheduler.request(() => {
      this.#handle = null
      this.#frameCounter += 1
      this.#timestamps.push(this.#clock.monotonicMs())
      if (this.#timestamps.length > this.#windowFrames) {
        this.#timestamps.splice(0, this.#timestamps.length - this.#windowFrames)
      }
      this.#onFrame()
      this.#schedule()
    })
  }
}

interface LoseContextExtension {
  restoreContext(): void
}

export interface Timers {
  setTimeout(handler: () => void, timeoutMs: number): number
  clearTimeout(handle: number): void
}

export const globalTimers: Timers = {
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs) as unknown as number,
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle)
  },
}

export interface WebGlContextTrackerOptions {
  log: RendererLog
  timers?: Timers
  restoreDelayMs?: number
  getLoseContextExtension?: (canvas: HTMLCanvasElement) => LoseContextExtension | null
}

/** Provisional (BOARD A-15): no spec value. */
export const DEFAULT_WEBGL_RESTORE_DELAY_MS = 1_000

function defaultLoseContextExtension(canvas: HTMLCanvasElement): LoseContextExtension | null {
  const context =
    (canvas.getContext('webgl2') as WebGLRenderingContext | null) ??
    (canvas.getContext('webgl') as WebGLRenderingContext | null)
  const extension = context?.getExtension('WEBGL_lose_context') as LoseContextExtension | null
  return extension ?? null
}

/**
 * Tracks `webglcontextlost` / `webglcontextrestored` (WebGL 1.0 spec §5.15.2)
 * and keeps asking for the context back.
 *
 * `preventDefault()` on the loss event is mandatory: without it the browser
 * never fires `webglcontextrestored`, so an OBS Browser Source would stay black
 * until someone restarts it. Every attempt is logged so a restart is visible in
 * the dev panel and in the health signal (spec §9.4(4), §11 "화면").
 */
export class WebGlContextTracker {
  readonly #log: RendererLog
  readonly #timers: Timers
  readonly #restoreDelayMs: number
  readonly #getExtension: (canvas: HTMLCanvasElement) => LoseContextExtension | null

  #canvas: HTMLCanvasElement | null = null
  #lost = false
  #lossCount = 0
  #restoredCount = 0
  #restoreAttempts = 0
  #restoreTimer: number | null = null

  readonly #onLost = (event: Event): void => {
    event.preventDefault()
    this.#lost = true
    this.#lossCount += 1
    this.#log.warn('webgl_context_lost', this.#lossCount)
    this.#scheduleRestore()
  }

  readonly #onRestored = (): void => {
    this.#lost = false
    this.#restoredCount += 1
    this.#cancelRestore()
    this.#log.info('webgl_context_restored', this.#restoredCount)
  }

  constructor(options: WebGlContextTrackerOptions) {
    this.#log = options.log
    this.#timers = options.timers ?? globalTimers
    this.#restoreDelayMs = options.restoreDelayMs ?? DEFAULT_WEBGL_RESTORE_DELAY_MS
    this.#getExtension = options.getLoseContextExtension ?? defaultLoseContextExtension
  }

  get lost(): boolean {
    return this.#lost
  }

  get lossCount(): number {
    return this.#lossCount
  }

  get restoredCount(): number {
    return this.#restoredCount
  }

  get restoreAttempts(): number {
    return this.#restoreAttempts
  }

  attach(canvas: HTMLCanvasElement): void {
    if (this.#canvas === canvas) return
    this.detach()
    this.#canvas = canvas
    canvas.addEventListener('webglcontextlost', this.#onLost)
    canvas.addEventListener('webglcontextrestored', this.#onRestored)
  }

  detach(): void {
    this.#cancelRestore()
    if (this.#canvas === null) return
    this.#canvas.removeEventListener('webglcontextlost', this.#onLost)
    this.#canvas.removeEventListener('webglcontextrestored', this.#onRestored)
    this.#canvas = null
  }

  #scheduleRestore(): void {
    this.#cancelRestore()
    this.#restoreTimer = this.#timers.setTimeout(() => {
      this.#restoreTimer = null
      if (!this.#lost) return
      const canvas = this.#canvas
      if (canvas === null) return
      const extension = this.#getExtension(canvas)
      if (extension === null) {
        this.#log.warn('webgl_restore_unavailable', this.#lossCount)
        this.#scheduleRestore()
        return
      }
      this.#restoreAttempts += 1
      this.#log.info('webgl_restore_requested', this.#restoreAttempts)
      extension.restoreContext()
      this.#scheduleRestore()
    }, this.#restoreDelayMs)
  }

  #cancelRestore(): void {
    if (this.#restoreTimer === null) return
    this.#timers.clearTimeout(this.#restoreTimer)
    this.#restoreTimer = null
  }
}

/** The three §9.4(4) signals the renderer reports, read from live sources. */
export class RendererHealth implements HealthSource {
  readonly #frameLoop: FrameLoop
  readonly #webgl: WebGlContextTracker

  constructor(frameLoop: FrameLoop, webgl: WebGlContextTracker) {
    this.#frameLoop = frameLoop
    this.#webgl = webgl
  }

  get frameCounter(): number {
    return this.#frameLoop.frameCounter
  }

  get fps(): number {
    return this.#frameLoop.fps
  }

  get webglContextLost(): boolean {
    return this.#webgl.lost
  }
}
