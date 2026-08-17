import {
  CONTRACT_VERSION,
  RendererToServerMessageSchema,
  ServerToRendererMessageSchema,
  type EffectId,
  type IsoUtcInstant,
  type RendererId,
  type RendererToServerMessage,
} from '@vl/contract'

import type { Clock } from './clock.js'
import type { HealthSource } from './health.js'
import type { RendererLog } from './log.js'
import type { ReadModel } from './store.js'

/**
 * WebSocket client for `/ws/renderer` (spec §7.3(6)(7), §9.4(4)).
 *
 * Everything that could make a test non-deterministic — the socket itself, the
 * clock, the jitter source — is injected (CLAUDE.md §4). Every inbound frame is
 * validated against the contract before it can reach the read model, and an
 * invalid frame is counted and dropped instead of throwing: a malformed message
 * must not be able to stop a 24/7 renderer.
 */

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped'

export interface WebSocketLike {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}

export interface BackoffConfig {
  initialMs: number
  maxMs: number
  factor: number
  /** Fraction of the delay applied as symmetric jitter, e.g. 0.2 = ±20%. */
  jitterRatio: number
}

export interface Timers {
  setTimeout(handler: () => void, timeoutMs: number): number
  clearTimeout(handle: number): void
  setInterval(handler: () => void, intervalMs: number): number
  clearInterval(handle: number): void
}

export const globalTimers: Timers = {
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs) as unknown as number,
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle)
  },
  setInterval: (handler, intervalMs) =>
    globalThis.setInterval(handler, intervalMs) as unknown as number,
  clearInterval: (handle) => {
    globalThis.clearInterval(handle)
  },
}

export interface RendererConnectionOptions {
  url: string
  rendererId: RendererId
  model: ReadModel
  health: HealthSource
  clock: Clock
  log: RendererLog
  backoff: BackoffConfig
  healthIntervalMs: number
  random?: () => number
  socketFactory?: (url: string) => WebSocketLike
  timers?: Timers
}

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike
}

export class RendererConnection {
  readonly #options: RendererConnectionOptions
  readonly #random: () => number
  readonly #socketFactory: (url: string) => WebSocketLike
  readonly #timers: Timers

  #socket: WebSocketLike | null = null
  #status: ConnectionStatus = 'idle'
  #reconnectAttempt = 0
  #reconnectCount = 0
  #rejectedMessageCount = 0
  #reconnectTimer: number | null = null
  #healthTimer: number | null = null
  #stopped = false

  readonly #listeners = new Set<() => void>()

  constructor(options: RendererConnectionOptions) {
    this.#options = options
    this.#random = options.random ?? Math.random
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory
    this.#timers = options.timers ?? globalTimers
  }

  get status(): ConnectionStatus {
    return this.#status
  }

  /** Reconnect attempts since start; reported by the dev panel (spec §9.4(3)). */
  get reconnectCount(): number {
    return this.#reconnectCount
  }

  get rejectedMessageCount(): number {
    return this.#rejectedMessageCount
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  start(): void {
    if (this.#stopped) return
    this.#options.model.setAckSink({
      ackState: (stateRevision, appliedAt) => this.#sendAckState(stateRevision, appliedAt),
      ackEffect: (effectId, appliedAt) => this.#sendAckEffect(effectId, appliedAt),
    })
    this.#connect()
  }

  stop(): void {
    this.#stopped = true
    this.#options.model.setAckSink(null)
    this.#clearReconnect()
    this.#stopHealthReports()
    const socket = this.#socket
    this.#socket = null
    if (socket !== null) {
      socket.onopen = null
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      socket.close()
    }
    this.#setStatus('stopped')
  }

  // --- connection lifecycle ----------------------------------------------

  #connect(): void {
    this.#setStatus('connecting')
    const socket = this.#socketFactory(this.#options.url)
    this.#socket = socket

    socket.onopen = () => {
      if (this.#socket !== socket) return
      this.#reconnectAttempt = 0
      this.#setStatus('open')
      this.#options.log.info('ws_open', this.#reconnectCount)
      this.#sendHello()
      this.#startHealthReports()
    }

    socket.onmessage = (event) => {
      if (this.#socket !== socket) return
      this.#receive(event.data)
    }

    socket.onerror = () => {
      if (this.#socket !== socket) return
      this.#options.log.warn('ws_error', this.#reconnectAttempt)
    }

    socket.onclose = () => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#stopHealthReports()
      if (this.#stopped) return
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect(): void {
    const delayMs = this.#nextDelayMs()
    this.#reconnectAttempt += 1
    this.#reconnectCount += 1
    this.#setStatus('reconnecting')
    this.#options.log.warn('ws_reconnect_scheduled', Math.round(delayMs))
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null
      if (this.#stopped) return
      this.#connect()
    }, delayMs)
  }

  /** Exponential backoff with symmetric jitter (spec §11 "연결 복구"). */
  #nextDelayMs(): number {
    const { initialMs, maxMs, factor, jitterRatio } = this.#options.backoff
    const base = Math.min(maxMs, initialMs * Math.pow(factor, this.#reconnectAttempt))
    const jitter = base * jitterRatio * (this.#random() * 2 - 1)
    return Math.max(0, base + jitter)
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer === null) return
    this.#timers.clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
  }

  // --- inbound ------------------------------------------------------------

  #receive(data: unknown): void {
    if (typeof data !== 'string') {
      this.#rejectMessage('non_string')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      this.#rejectMessage('invalid_json')
      return
    }

    const result = ServerToRendererMessageSchema.safeParse(parsed)
    if (!result.success) {
      // Only the failing path and issue code are logged. Values off the wire are
      // never echoed to the screen or the console (spec §12.3).
      const issue = result.error.issues[0]
      this.#rejectMessage(issue === undefined ? 'invalid' : `${issue.path.join('.')}:${issue.code}`)
      return
    }

    const message = result.data
    switch (message.type) {
      case 'snapshot':
        this.#options.model.receiveSnapshot(message.snapshot)
        return
      case 'effect':
        this.#options.model.receiveEffect(message.effect)
        return
      case 'ping':
        this.#sendHealth()
        return
    }
  }

  #rejectMessage(reason: string): void {
    this.#rejectedMessageCount += 1
    this.#options.log.warn('ws_message_rejected', reason)
    this.#notify()
  }

  // --- outbound -----------------------------------------------------------

  #sendHello(): void {
    this.#send({
      schemaVersion: CONTRACT_VERSION,
      type: 'hello',
      rendererId: this.#options.rendererId,
      lastAppliedStateRevision: this.#options.model.lastAppliedStateRevision,
    })
  }

  #sendAckState(stateRevision: number, appliedAt: IsoUtcInstant): void {
    this.#send({ schemaVersion: CONTRACT_VERSION, type: 'ack_state', stateRevision, appliedAt })
  }

  #sendAckEffect(effectId: EffectId, appliedAt: IsoUtcInstant): void {
    this.#send({ schemaVersion: CONTRACT_VERSION, type: 'ack_effect', effectId, appliedAt })
  }

  #sendHealth(): void {
    const fps = this.#options.health.fps
    this.#send({
      schemaVersion: CONTRACT_VERSION,
      type: 'renderer_health',
      frameCounter: this.#options.health.frameCounter,
      fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : 0,
      webglContextLost: this.#options.health.webglContextLost,
      lastAppliedStateRevision: this.#options.model.lastAppliedStateRevision,
      lastAppliedEffectId: this.#options.model.lastAppliedEffectId,
    })
  }

  #startHealthReports(): void {
    this.#stopHealthReports()
    this.#sendHealth()
    this.#healthTimer = this.#timers.setInterval(() => {
      this.#sendHealth()
    }, this.#options.healthIntervalMs)
  }

  #stopHealthReports(): void {
    if (this.#healthTimer === null) return
    this.#timers.clearInterval(this.#healthTimer)
    this.#healthTimer = null
  }

  #send(message: RendererToServerMessage): void {
    const socket = this.#socket
    if (socket === null || this.#status !== 'open') {
      this.#options.log.warn('ws_send_dropped', message.type)
      return
    }
    // The renderer never emits an off-contract frame: a bug here is dropped and
    // logged rather than pushed onto the wire.
    const encoded = RendererToServerMessageSchema.safeParse(message)
    if (!encoded.success) {
      this.#options.log.warn('ws_send_invalid', message.type)
      return
    }
    socket.send(JSON.stringify(encoded.data))
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return
    this.#status = status
    this.#notify()
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
}
