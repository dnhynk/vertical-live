import { CONTRACT_VERSION, ServerToRendererMessageSchema, type Effect } from '@vl/contract'
import type { Clock } from '@vl/server'
import WebSocket from 'ws'

/**
 * The renderer under fault injection (spec §11 row "WebGL context loss"; §9.4(4)
 * frame counter, FPS, WebGL context; §11 화면 "72시간 동안 frame counter·state
 * revision·WebGL context를 계측").
 *
 * It is a separate client from T11's `StubRenderer` on purpose: that one holds
 * **no** health state — deliberately, so its own `Set` can never be mistaken for
 * evidence about the real read model — and §T15 needs exactly the health state it
 * refuses to keep: a frame counter that a freeze can stall, an FPS the supervisor
 * can judge against `supervisor.renderer.minFps`, and a WebGL context flag. Both
 * speak the same contract; neither is a second implementation of the renderer.
 *
 * What it does *not* do is decide anything about a freeze from a picture. Spec
 * §9.4 rules that out ("장면 hash 변화만으로 freeze를 판정하지 않는다"); a freeze
 * here is a frame counter that stopped advancing while the world moved on, which
 * is the counter §11 asks to be instrumented.
 */

export interface SoakRendererOptions {
  readonly token: string
  readonly clock: Clock
  /** Frames the renderer produces per second while healthy. */
  readonly fps?: number
  readonly rendererId?: string
}

export class SoakRenderer {
  readonly #options: SoakRendererOptions
  readonly #fps: number
  /** Set by `connectTo`; the port is only known once the server is listening. */
  #wsUrl: string | null = null
  #socket: WebSocket | null = null
  #frameCounter = 0
  #lastAppliedStateRevision: number | null = null
  #lastAppliedEffectId: string | null = null
  #webglContextLost = false
  #frozen = false
  #seenEffectIds = new Set<string>()

  /** Effect frames received, including retransmissions (spec §11 유료 무결성). */
  readonly effectFrames: Effect[] = []
  /** Frames carrying an `effectId` this renderer had already played. */
  repeatedEffectFrames = 0
  /** Snapshots applied, for the "state revision advanced" half of a freeze. */
  snapshotsApplied = 0

  constructor(options: SoakRendererOptions) {
    this.#options = options
    this.#fps = options.fps ?? 30
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === WebSocket.OPEN
  }

  get frameCounter(): number {
    return this.#frameCounter
  }

  get webglContextLost(): boolean {
    return this.#webglContextLost
  }

  get distinctEffects(): number {
    return this.#seenEffectIds.size
  }

  // ------------------------------------------------------------ fault control

  /**
   * The browser lost the WebGL context. Frames stop and the flag is reported,
   * which is §9.4(4)'s own signal — no screenshot is involved.
   */
  loseWebglContext(): void {
    this.#webglContextLost = true
    this.#frozen = true
  }

  restoreWebglContext(): void {
    this.#webglContextLost = false
    this.#frozen = false
  }

  /** Frames stop advancing while the context is nominally fine. */
  freeze(): void {
    this.#frozen = true
  }

  thaw(): void {
    this.#frozen = false
  }

  // -------------------------------------------------------------------- wire

  /** Connects to (or reconnects to) a renderer WebSocket URL. */
  async connectTo(wsUrl: string): Promise<void> {
    this.#wsUrl = wsUrl
    await this.connect()
  }

  async connect(): Promise<void> {
    if (this.#socket !== null) return
    if (this.#wsUrl === null) throw new Error('soak renderer has no URL; call connectTo() first')
    const url = new URL(this.#wsUrl)
    url.searchParams.set('token', this.#options.token)
    const socket = new WebSocket(url)
    this.#socket = socket
    socket.on('message', (data: unknown) => {
      this.#receive(String(data))
    })
    socket.on('close', () => {
      this.#socket = null
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve()
      })
      socket.once('error', reject)
    })
    this.#send({
      schemaVersion: CONTRACT_VERSION,
      type: 'hello',
      rendererId: this.#options.rendererId ?? 'renderer-soak-stub',
      lastAppliedStateRevision: this.#lastAppliedStateRevision,
    })
  }

  async disconnect(): Promise<void> {
    const socket = this.#socket
    if (socket === null) return
    await new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve()
      })
      socket.close()
    })
    this.#socket = null
  }

  /** `ComponentActions.rendererSource`: the OBS Browser Source is reloaded. */
  readonly reload = async (signal: AbortSignal): Promise<void> => {
    await this.disconnect()
    if (signal.aborted) return
    this.restoreWebglContext()
    await this.connect()
  }

  /**
   * Advances the renderer by `elapsedMs` of scenario time and reports §9.4(4).
   * A frozen renderer keeps its frame counter where it is, which is exactly what
   * the supervisor has to notice.
   */
  reportHealth(elapsedMs: number): void {
    if (!this.#frozen) {
      this.#frameCounter += Math.max(0, Math.round((this.#fps * elapsedMs) / 1000))
    }
    this.#send({
      schemaVersion: CONTRACT_VERSION,
      type: 'renderer_health',
      frameCounter: this.#frameCounter,
      fps: this.#frozen ? 0 : this.#fps,
      webglContextLost: this.#webglContextLost,
      lastAppliedStateRevision: this.#lastAppliedStateRevision,
      lastAppliedEffectId: this.#lastAppliedEffectId,
    })
  }

  #receive(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const message = ServerToRendererMessageSchema.safeParse(parsed)
    if (!message.success) return
    switch (message.data.type) {
      case 'snapshot': {
        // A renderer whose context is gone draws nothing, so it applies nothing
        // and ACKs nothing — which is how the ACK-staleness path is reached.
        if (this.#webglContextLost) return
        this.#lastAppliedStateRevision = message.data.snapshot.stateRevision
        this.snapshotsApplied += 1
        this.#send({
          schemaVersion: CONTRACT_VERSION,
          type: 'ack_state',
          stateRevision: message.data.snapshot.stateRevision,
          appliedAt: this.#options.clock.nowUtcIso(),
        })
        return
      }
      case 'effect': {
        const effect = message.data.effect
        this.effectFrames.push(effect)
        if (this.#seenEffectIds.has(effect.effectId)) this.repeatedEffectFrames += 1
        else this.#seenEffectIds.add(effect.effectId)
        if (this.#webglContextLost) return
        this.#lastAppliedEffectId = effect.effectId
        this.#send({
          schemaVersion: CONTRACT_VERSION,
          type: 'ack_effect',
          effectId: effect.effectId,
          appliedAt: this.#options.clock.nowUtcIso(),
        })
        return
      }
      case 'ping':
        return
    }
  }

  #send(message: unknown): void {
    const socket = this.#socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(message))
  }
}
