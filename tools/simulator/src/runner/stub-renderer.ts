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
 * no read model and holds no world state. `effectStarts` counts distinct effect
 * ids, which says what the *wire* carried and nothing about what a renderer
 * would do with it — the stub's own `Set` cannot be evidence for spec §11's
 * "같은 paid effectId가 재전송돼도 연출을 재시작하지 않음" (review round 1, M2).
 * `effectLog` exists for that: it keeps every frame with the instant it arrived,
 * so `apps/renderer/src/replay/paid-effect-idempotence.test.ts` can replay the
 * real retransmissions through the production `ReadModel`.
 */

/** One received effect frame and the instant this renderer saw it. */
export interface ObservedEffect {
  readonly effect: Effect
  /** `clock.nowUtcIso()` at arrival; the production read model needs it. */
  readonly atUtc: string
}

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
  /** The same frames, each with its arrival instant, in arrival order. */
  readonly effectLog: ObservedEffect[] = []
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
        const atUtc = this.#options.clock.nowUtcIso()
        this.effectFrames.push(effect)
        this.effectLog.push({ effect, atUtc })
        if (this.#seenEffectIds.has(effect.effectId)) this.repeatedEffectFrames += 1
        else this.#seenEffectIds.add(effect.effectId)
        if (this.#options.ackEffects !== false) {
          this.#send({
            schemaVersion: CONTRACT_VERSION,
            type: 'ack_effect',
            effectId: effect.effectId,
            appliedAt: atUtc,
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
