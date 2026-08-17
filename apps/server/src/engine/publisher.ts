import { timingSafeEqual } from 'node:crypto'
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
 * The upgrade is loopback-only **and authenticated**, which spec §10.2 requires
 * of both renderer and obs-websocket surfaces. Loopback alone is not access
 * control on a desktop host: any other local process could otherwise subscribe
 * to snapshots and send contract-valid ACK and health frames, which would let it
 * drive the server's degraded decision (R-T8-1 blocker 3).
 *
 * The token travels in the query string because that is the only channel an OBS
 * Browser Source has — it cannot set a header. The vault is authoritative for
 * the value and the server injects it into the Browser Source URL at runtime
 * (`SetInputSettings`, T12/T17), the same custody rule the stream key follows
 * (BOARD A-16); `docs/ops/obs-setup.md` records that the URL is cached in the
 * OBS scene collection on disk.
 */

export const RENDERER_WS_PATH = '/ws/renderer'

/** Query parameter carrying the renderer token on the upgrade request. */
export const RENDERER_TOKEN_PARAM = 'token'

/**
 * Application close code for a refused renderer. 4000–4999 is the range
 * RFC 6455 §7.4.2 reserves for private use, and a distinct code is what lets the
 * renderer log "unauthorized" instead of retrying against a transport error.
 */
export const RENDERER_UNAUTHORIZED_CLOSE_CODE = 4401

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
  /**
   * `server.rendererToken` from the vault (T3). Required: an unset token closes
   * the door rather than opening it, exactly like the simulator endpoint.
   */
  readonly token: string
  readonly logger?: Logger
  /** Liveness probe interval; the renderer answers with `renderer_health`. */
  readonly pingIntervalMs?: number
}

export class RendererHub implements EnginePublisher {
  readonly #wss: WebSocketServer
  readonly #clock: Clock
  readonly #events: RendererEvents
  readonly #logger: Logger
  readonly #token: string
  readonly #sockets = new Set<WebSocket>()
  #lastHealth: RendererHealthReport | null = null

  constructor(options: RendererHubOptions) {
    this.#clock = options.clock
    this.#events = options.events
    this.#logger = options.logger ?? silentLogger
    this.#token = options.token
    this.#wss = new WebSocketServer({ noServer: true })

    options.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== RENDERER_WS_PATH) {
        socket.destroy()
        return
      }
      if (!isLoopback(request)) {
        // Loopback only (spec §10.2). Nothing about the rejection is echoed back.
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      const authorized = this.#authorized(url.searchParams.get(RENDERER_TOKEN_PARAM))
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        if (!authorized) {
          // Closed before it is registered: it never counts as a renderer, never
          // receives a snapshot, and none of its frames are read.
          this.#logger.warn('renderer.unauthorized')
          ws.close(RENDERER_UNAUTHORIZED_CLOSE_CODE, 'unauthorized')
          return
        }
        this.#attach(ws)
      })
    })
  }

  /** Constant-time comparison; an unconfigured token refuses every connection. */
  #authorized(presented: string | null): boolean {
    if (this.#token === '') return false
    if (presented === null) return false
    const offered = Buffer.from(presented)
    const secret = Buffer.from(this.#token)
    if (offered.length !== secret.length) return false
    return timingSafeEqual(offered, secret)
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
        const {
          frameCounter,
          fps,
          webglContextLost,
          lastAppliedStateRevision,
          lastAppliedEffectId,
        } = message.data
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
