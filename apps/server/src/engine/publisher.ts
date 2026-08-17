import type { IncomingMessage, Server } from 'node:http'

import {
  CONTRACT_VERSION,
  RendererToServerMessageSchema,
  type Effect,
  type WorldSnapshot,
} from '@vl/contract'
import { WebSocketServer, type WebSocket } from 'ws'

import type { Clock } from '../clock.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { EnginePublisher } from './engine.js'

/**
 * The `/ws/renderer` hub of spec §7.3(6)(7).
 *
 * It is a transport and nothing else: it serializes what the engine committed
 * and hands renderer messages back. It holds no state the renderer could rely
 * on, because the renderer is a read model that must recover from a server
 * snapshot alone (spec §10.2).
 *
 * The upgrade is loopback-only, like every other surface of this server
 * (spec §10.2): the renderer runs in OBS on the same host.
 */

export const RENDERER_WS_PATH = '/ws/renderer'

/** What the hub reports back to the engine (spec §7.3(7), §9.4(4)). */
export interface RendererEvents {
  onHello(lastAppliedStateRevision: number | null): void
  onAckState(stateRevision: number, appliedAt: string): void
  onAckEffect(effectId: string, appliedAt: string): void
  onHealth(health: {
    readonly frameCounter: number
    readonly fps: number
    readonly webglContextLost: boolean
    readonly lastAppliedStateRevision: number | null
    readonly lastAppliedEffectId: string | null
  }): void
}

export interface RendererHubOptions {
  readonly server: Server
  readonly clock: Clock
  readonly events: RendererEvents
  readonly logger?: Logger
  /** Liveness probe interval; the renderer answers with `renderer_health`. */
  readonly pingIntervalMs?: number
}

export class RendererHub implements EnginePublisher {
  readonly #wss: WebSocketServer
  readonly #clock: Clock
  readonly #events: RendererEvents
  readonly #logger: Logger
  readonly #sockets = new Set<WebSocket>()
  #lastHealth: RendererHealthReport | null = null

  constructor(options: RendererHubOptions) {
    this.#clock = options.clock
    this.#events = options.events
    this.#logger = options.logger ?? silentLogger
    this.#wss = new WebSocketServer({ noServer: true })

    options.server.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (pathname !== RENDERER_WS_PATH) {
        socket.destroy()
        return
      }
      if (!isLoopback(request)) {
        // Loopback only (spec §10.2). Nothing about the rejection is echoed back.
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.#attach(ws)
      })
    })
  }

  get rendererCount(): number {
    return this.#sockets.size
  }

  /** Last health frame received, for `GET /health` (spec §9.4(4)). */
  get lastHealth(): RendererHealthReport | null {
    return this.#lastHealth
  }

  publishSnapshot(snapshot: WorldSnapshot): void {
    this.#broadcast({
      schemaVersion: CONTRACT_VERSION,
      type: 'snapshot',
      sentAt: this.#clock.nowUtcIso(),
      snapshot,
    })
  }

  publishEffect(effect: Effect): void {
    this.#broadcast({
      schemaVersion: CONTRACT_VERSION,
      type: 'effect',
      sentAt: this.#clock.nowUtcIso(),
      effect,
    })
  }

  ping(): void {
    this.#broadcast({
      schemaVersion: CONTRACT_VERSION,
      type: 'ping',
      sentAt: this.#clock.nowUtcIso(),
    })
  }

  close(): void {
    for (const socket of this.#sockets) socket.close()
    this.#sockets.clear()
    this.#wss.close()
  }

  #attach(socket: WebSocket): void {
    this.#sockets.add(socket)
    socket.on('close', () => {
      this.#sockets.delete(socket)
    })
    socket.on('error', () => {
      this.#sockets.delete(socket)
    })
    socket.on('message', (data: unknown) => {
      this.#receive(String(data))
    })
  }

  #receive(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.#logger.warn('renderer.unparseable_frame')
      return
    }
    const message = RendererToServerMessageSchema.safeParse(parsed)
    if (!message.success) {
      // The frame itself is never logged: it comes from a browser context and
      // logging unvalidated input is how raw text escapes (spec §12.3).
      this.#logger.warn('renderer.invalid_frame')
      return
    }
    switch (message.data.type) {
      case 'hello':
        this.#events.onHello(message.data.lastAppliedStateRevision)
        return
      case 'ack_state':
        this.#events.onAckState(message.data.stateRevision, message.data.appliedAt)
        return
      case 'ack_effect':
        this.#events.onAckEffect(message.data.effectId, message.data.appliedAt)
        return
      case 'renderer_health': {
        const { frameCounter, fps, webglContextLost, lastAppliedStateRevision, lastAppliedEffectId } =
          message.data
        this.#lastHealth = {
          frameCounter,
          fps,
          webglContextLost,
          lastAppliedStateRevision,
          lastAppliedEffectId,
          observedAtUtc: this.#clock.nowUtcIso(),
        }
        this.#events.onHealth(this.#lastHealth)
        return
      }
    }
  }

  #broadcast(message: unknown): void {
    if (this.#sockets.size === 0) return
    const payload = JSON.stringify(message)
    for (const socket of this.#sockets) {
      if (socket.readyState !== socket.OPEN) continue
      socket.send(payload)
    }
  }
}

export interface RendererHealthReport {
  readonly frameCounter: number
  readonly fps: number
  readonly webglContextLost: boolean
  readonly lastAppliedStateRevision: number | null
  readonly lastAppliedEffectId: string | null
  readonly observedAtUtc: string
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
