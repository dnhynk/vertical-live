import {
  CONTRACT_VERSION,
  ServerToRendererMessageSchema,
  type Effect,
  type WorldSnapshot,
} from '@vl/contract'
import type { Clock } from '@vl/server'
import WebSocket from 'ws'

/**
 * A renderer that only does the two things spec §7.3(7) makes the renderer
 * responsible for: it ACKs the `stateRevision` and `effectId` it "applied", and
 * it never starts the same `effectId` twice.
 *
 * It is what closes the `published → acked` and `received → acked` legs of the
 * §7.3(8) measurement — without an ACK those two stages have no samples at all,
 * so the latency report would silently only cover the server half.
 *
 * It is *not* a second implementation of the renderer. It draws nothing, keeps
 * no read model and holds no world state; `effectStarts` counts distinct effect
 * ids so a replayed paid effect can be shown not to restart (spec §11 유료
 * 무결성), and the full renderer's own idempotence is covered by T5
 * (`apps/renderer/src/read-model/store.test.ts`).
 */

export interface StubRendererOptions {
  readonly wsUrl: string
  readonly token: string
  readonly clock: Clock
  /** Identifies this browser instance, never a person (spec §12.4, BOARD A-1). */
  readonly rendererId?: string
  /** Off for the "renderer connected but not acking" degraded probe. */
  readonly ackStates?: boolean
  readonly ackEffects?: boolean
}

export class StubRenderer {
  readonly #options: StubRendererOptions
  #socket: WebSocket | null = null
  #seenEffectIds = new Set<string>()

  readonly snapshots: WorldSnapshot[] = []
  /** Every effect frame received, including retransmits. */
  readonly effectFrames: Effect[] = []
  /** Frames that carried an `effectId` this renderer had already played. */
  repeatedEffectFrames = 0
  closeCode: number | null = null

  constructor(options: StubRendererOptions) {
    this.#options = options
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === WebSocket.OPEN
  }

  /** Distinct effect ids, i.e. how many stagings a viewer would have seen. */
  get effectStarts(): number {
    return this.#seenEffectIds.size
  }

  get lastSnapshot(): WorldSnapshot | null {
    return this.snapshots.at(-1) ?? null
  }

  async connect(): Promise<void> {
    if (this.#socket !== null) throw new Error('stub renderer is already connected')
    const url = new URL(this.#options.wsUrl)
    url.searchParams.set('token', this.#options.token)
    const socket = new WebSocket(url)
    this.#socket = socket
    socket.on('message', (data: unknown) => {
      this.#receive(String(data))
    })
    socket.on('close', (code: number) => {
      this.closeCode = code
      this.#socket = null
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve()
      })
      socket.once('error', reject)
      socket.once('close', (code: number) => {
        reject(new Error(`stub renderer refused with close code ${String(code)}`))
      })
    })
    this.#send({
      schemaVersion: CONTRACT_VERSION,
      type: 'hello',
      rendererId: this.#options.rendererId ?? 'renderer-simulator-stub',
      lastAppliedStateRevision: null,
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
        this.snapshots.push(message.data.snapshot)
        if (this.#options.ackStates !== false) {
          this.#send({
            schemaVersion: CONTRACT_VERSION,
            type: 'ack_state',
            stateRevision: message.data.snapshot.stateRevision,
            appliedAt: this.#options.clock.nowUtcIso(),
          })
        }
        return
      }
      case 'effect': {
        const effect = message.data.effect
        this.effectFrames.push(effect)
        if (this.#seenEffectIds.has(effect.effectId)) this.repeatedEffectFrames += 1
        else this.#seenEffectIds.add(effect.effectId)
        if (this.#options.ackEffects !== false) {
          this.#send({
            schemaVersion: CONTRACT_VERSION,
            type: 'ack_effect',
            effectId: effect.effectId,
            appliedAt: this.#options.clock.nowUtcIso(),
          })
        }
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
