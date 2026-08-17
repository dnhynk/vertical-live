import type { Clock } from '../read-model/clock'
import type { Timers as ConnectionTimers, WebSocketLike } from '../read-model/connection'
import type { FrameScheduler, Timers as HealthTimers } from '../read-model/health'

/**
 * Deterministic doubles for the injected seams of the renderer runtime
 * (CLAUDE.md §4: injected clock, injected randomness, no wall-clock waits).
 * Test-only: nothing here is imported by the application.
 */

const DEFAULT_START_WALL_MS = Date.parse('2026-08-17T00:00:00.000Z')

export class FakeClock implements Clock {
  #monotonicMs = 0
  #wallMs: number

  constructor(startWallMs: number = DEFAULT_START_WALL_MS) {
    this.#wallMs = startWallMs
  }

  monotonicMs(): number {
    return this.#monotonicMs
  }

  wallMs(): number {
    return this.#wallMs
  }

  nowIso(): string {
    return new Date(this.#wallMs).toISOString()
  }

  advance(ms: number): void {
    this.#monotonicMs += ms
    this.#wallMs += ms
  }
}

export class FakeWebSocket implements WebSocketLike {
  readonly url: string
  readonly sent: string[] = []
  closed = false

  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** Test-side: the server accepted the connection. */
  emitOpen(): void {
    this.onopen?.()
  }

  /** Test-side: a frame arrived from the server. */
  emitMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }

  emitError(): void {
    this.onerror?.()
  }

  /** Test-side: the socket dropped. */
  emitClose(): void {
    this.closed = true
    this.onclose?.()
  }

  parsedSent(): unknown[] {
    return this.sent.map((entry) => JSON.parse(entry) as unknown)
  }
}

export interface FakeSocketFactory {
  factory: (url: string) => WebSocketLike
  sockets: FakeWebSocket[]
  last(): FakeWebSocket
}

export function createFakeSocketFactory(): FakeSocketFactory {
  const sockets: FakeWebSocket[] = []
  return {
    sockets,
    factory: (url: string) => {
      const socket = new FakeWebSocket(url)
      sockets.push(socket)
      return socket
    },
    last() {
      const socket = sockets[sockets.length - 1]
      if (socket === undefined) throw new Error('no socket was created')
      return socket
    },
  }
}

export class FakeFrameScheduler implements FrameScheduler {
  #nextHandle = 1
  #pending = new Map<number, () => void>()

  request(callback: () => void): number {
    const handle = this.#nextHandle
    this.#nextHandle += 1
    this.#pending.set(handle, callback)
    return handle
  }

  cancel(handle: number): void {
    this.#pending.delete(handle)
  }

  /** Runs the frames that are currently scheduled, once each. */
  runFrame(count = 1): void {
    for (let index = 0; index < count; index += 1) {
      const entries = [...this.#pending.entries()]
      this.#pending.clear()
      for (const [, callback] of entries) callback()
    }
  }

  get pendingCount(): number {
    return this.#pending.size
  }
}

interface ScheduledTask {
  readonly handle: number
  runAt: number
  readonly intervalMs: number | null
  readonly handler: () => void
}

export class FakeTimers implements ConnectionTimers, HealthTimers {
  readonly #clock: FakeClock | null
  readonly #tasks = new Map<number, ScheduledTask>()
  #nextHandle = 1
  #now = 0

  constructor(clock: FakeClock | null = null) {
    this.#clock = clock
  }

  setTimeout(handler: () => void, timeoutMs: number): number {
    return this.#schedule(handler, timeoutMs, null)
  }

  clearTimeout(handle: number): void {
    this.#tasks.delete(handle)
  }

  setInterval(handler: () => void, intervalMs: number): number {
    return this.#schedule(handler, intervalMs, intervalMs)
  }

  clearInterval(handle: number): void {
    this.#tasks.delete(handle)
  }

  get pendingCount(): number {
    return this.#tasks.size
  }

  /** Advances virtual time, running due tasks in order (and the clock with it). */
  advance(ms: number): void {
    const target = this.#now + ms
    for (;;) {
      let next: ScheduledTask | null = null
      for (const task of this.#tasks.values()) {
        if (task.runAt > target) continue
        if (
          next === null ||
          task.runAt < next.runAt ||
          (task.runAt === next.runAt && task.handle < next.handle)
        ) {
          next = task
        }
      }
      if (next === null) break
      this.#advanceTo(next.runAt)
      if (next.intervalMs === null) this.#tasks.delete(next.handle)
      else next.runAt = next.runAt + next.intervalMs
      next.handler()
    }
    this.#advanceTo(target)
  }

  #advanceTo(time: number): void {
    const delta = time - this.#now
    if (delta <= 0) return
    this.#now = time
    this.#clock?.advance(delta)
  }

  #schedule(handler: () => void, delayMs: number, intervalMs: number | null): number {
    const handle = this.#nextHandle
    this.#nextHandle += 1
    this.#tasks.set(handle, { handle, runAt: this.#now + delayMs, intervalMs, handler })
    return handle
  }
}

/** Deterministic replacement for `Math.random` in the reconnect jitter. */
export function sequenceRandom(values: readonly number[]): () => number {
  let index = 0
  return () => {
    const value = values[index % values.length] ?? 0.5
    index += 1
    return value
  }
}
