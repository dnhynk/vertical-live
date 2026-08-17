// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { RendererToServerMessage } from '@vl/contract'

import { createRuntime, type RendererRuntime } from '../runtime'
import {
  FakeClock,
  FakeFrameScheduler,
  FakeTimers,
  createFakeSocketFactory,
  sequenceRandom,
  type FakeSocketFactory,
} from '../testing/fakes'
import {
  effectMessage,
  pingMessage,
  sampleActionEffect,
  sampleSnapshot,
  snapshotMessage,
} from '../testing/fixtures'

/**
 * TASK_SPECS §T5 acceptance 1: one play per `effectId`, `ack_state` after a
 * snapshot is applied, and a reconnect `hello` that carries the last applied
 * revision. Driven through the real runtime with an injected socket, frame
 * scheduler, timers and jitter source, so the assertions are on the bytes the
 * renderer would actually put on `/ws/renderer`.
 */

interface Harness {
  runtime: RendererRuntime
  clock: FakeClock
  timers: FakeTimers
  scheduler: FakeFrameScheduler
  sockets: FakeSocketFactory
  /** Stands in for a React commit; the App does this in a layout effect. */
  commitAndPaint(): void
  sentTo(socketIndex: number): RendererToServerMessage[]
}

function createHarness(search = ''): Harness {
  const clock = new FakeClock()
  const timers = new FakeTimers(clock)
  const scheduler = new FakeFrameScheduler()
  const sockets = createFakeSocketFactory()
  const runtime = createRuntime({
    search,
    clock,
    timers,
    frameScheduler: scheduler,
    socketFactory: sockets.factory,
    // 0.5 makes the symmetric jitter exactly zero, so delays are the base delay.
    random: sequenceRandom([0.5]),
    generateRendererId: () => 'renderer-test',
  })
  runtime.start()
  return {
    runtime,
    clock,
    timers,
    scheduler,
    sockets,
    commitAndPaint() {
      runtime.model.markCommitted()
      scheduler.runFrame()
    },
    sentTo(socketIndex: number) {
      const socket = sockets.sockets[socketIndex]
      if (socket === undefined) throw new Error(`no socket ${String(socketIndex)}`)
      return socket.parsedSent() as RendererToServerMessage[]
    },
  }
}

function typesOf(messages: RendererToServerMessage[]): string[] {
  return messages.map((message) => message.type)
}

describe('renderer WebSocket client (spec §7.3(6)(7), §9.4(4))', () => {
  it('says hello with no revision on the first connection', () => {
    const harness = createHarness()
    harness.sockets.last().emitOpen()

    const hello = harness.sentTo(0)[0]
    expect(hello).toEqual({
      schemaVersion: 1,
      type: 'hello',
      rendererId: 'renderer-test',
      lastAppliedStateRevision: null,
    })
    harness.runtime.stop()
  })

  it('acks the revision it drew, and only after the frame that drew it', () => {
    const harness = createHarness()
    const socket = harness.sockets.last()
    socket.emitOpen()

    socket.emitMessage(snapshotMessage(sampleSnapshot({ stateRevision: 5 })))
    expect(typesOf(harness.sentTo(0))).not.toContain('ack_state')

    harness.commitAndPaint()
    const ack = harness.sentTo(0).find((message) => message.type === 'ack_state')
    expect(ack).toEqual({
      schemaVersion: 1,
      type: 'ack_state',
      stateRevision: 5,
      appliedAt: '2026-08-17T00:00:00.000Z',
    })
    harness.runtime.stop()
  })

  it('plays one effectId once and acks it, and does not replay a resend', () => {
    const harness = createHarness()
    const socket = harness.sockets.last()
    socket.emitOpen()

    socket.emitMessage(effectMessage(sampleActionEffect()))
    socket.emitMessage(effectMessage(sampleActionEffect()))
    harness.commitAndPaint()

    expect(harness.runtime.model.effectStartCount).toBe(1)
    expect(harness.runtime.model.activeEffects).toHaveLength(1)
    const effectAcks = harness.sentTo(0).filter((message) => message.type === 'ack_effect')
    expect(effectAcks).toHaveLength(1)
    expect(effectAcks[0]).toMatchObject({ effectId: 'sample-effect-action-1' })
    harness.runtime.stop()
  })

  it('reconnects with backoff and repeats the last applied revision in hello', () => {
    const harness = createHarness()
    const first = harness.sockets.last()
    first.emitOpen()
    first.emitMessage(snapshotMessage(sampleSnapshot({ stateRevision: 42 })))
    harness.commitAndPaint()

    first.emitClose()
    expect(harness.runtime.connection.status).toBe('reconnecting')
    expect(harness.sockets.sockets).toHaveLength(1)

    // initialMs 500 with zero jitter.
    harness.timers.advance(499)
    expect(harness.sockets.sockets).toHaveLength(1)
    harness.timers.advance(1)
    expect(harness.sockets.sockets).toHaveLength(2)

    const second = harness.sockets.last()
    second.emitOpen()
    expect(harness.sentTo(1)[0]).toMatchObject({
      type: 'hello',
      lastAppliedStateRevision: 42,
    })
    expect(harness.runtime.connection.reconnectCount).toBe(1)
    harness.runtime.stop()
  })

  it('backs off exponentially while the server stays down', () => {
    const harness = createHarness()
    const delays: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.sockets.last().emitClose()
      const scheduled = harness.runtime.log
        .entries()
        .filter((entry) => entry.code === 'ws_reconnect_scheduled')
      delays.push(Number(scheduled[scheduled.length - 1]?.detail))
      harness.timers.advance(20_000)
    }
    expect(delays).toEqual([500, 1000, 2000])
    harness.runtime.stop()
  })

  it('reports renderer health on connect, on ping and on the interval', () => {
    const harness = createHarness()
    const socket = harness.sockets.last()
    socket.emitOpen()
    harness.scheduler.runFrame(3)

    socket.emitMessage(pingMessage())
    harness.timers.advance(1_000)

    const health = harness.sentTo(0).filter((message) => message.type === 'renderer_health')
    expect(health).toHaveLength(3)
    expect(health[0]).toMatchObject({
      frameCounter: 0,
      webglContextLost: false,
      lastAppliedStateRevision: null,
      lastAppliedEffectId: null,
    })
    expect(health[1]).toMatchObject({ frameCounter: 3 })
    harness.runtime.stop()
  })

  it('drops a malformed frame instead of letting it stop the renderer', () => {
    const harness = createHarness()
    const socket = harness.sockets.last()
    socket.emitOpen()

    socket.emitMessage('{ not json')
    socket.emitMessage({ schemaVersion: 1, type: 'snapshot' })
    socket.emitMessage({ schemaVersion: 1, sentAt: 'not-a-time', type: 'ping' })
    socket.emitMessage(snapshotMessage(sampleSnapshot({ stateRevision: 2 })))

    expect(harness.runtime.connection.rejectedMessageCount).toBe(3)
    expect(harness.runtime.model.snapshot?.stateRevision).toBe(2)
    harness.runtime.stop()
  })

  it('never writes to browser storage, so a refresh recovers from the server', () => {
    const harness = createHarness('?mode=dev')
    const socket = harness.sockets.last()
    socket.emitOpen()
    socket.emitMessage(snapshotMessage(sampleSnapshot({ stateRevision: 11 })))
    socket.emitMessage(effectMessage(sampleActionEffect()))
    harness.commitAndPaint()

    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
    expect(document.cookie).toBe('')

    // A fresh runtime (the refresh) knows nothing until the server tells it.
    const reloaded = createHarness('?mode=dev')
    expect(reloaded.runtime.model.snapshot).toBeNull()
    expect(reloaded.runtime.model.lastAppliedStateRevision).toBeNull()

    harness.runtime.stop()
    reloaded.runtime.stop()
  })
})
