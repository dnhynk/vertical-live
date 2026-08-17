// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { RendererToServerMessage } from '@vl/contract'

import { createRuntime } from '../runtime'
import {
  FakeClock,
  FakeFrameScheduler,
  FakeTimers,
  createFakeSocketFactory,
  sequenceRandom,
} from '../testing/fakes'
import { FrameLoop, WebGlContextTracker } from './health'
import { RendererLog } from './log'

/**
 * TASK_SPECS §T5 acceptance 2: a simulated WebGL context loss shows up in
 * `renderer_health` and leaves a record of the recovery attempts (spec §9.4(4)).
 *
 * The loss is simulated the way the fault matrix of spec §11 describes it — the
 * `webglcontextlost` event the browser fires — not by poking a private field.
 */

function loseContext(canvas: HTMLCanvasElement): Event {
  const event = new Event('webglcontextlost', { cancelable: true })
  canvas.dispatchEvent(event)
  return event
}

function restoreContext(canvas: HTMLCanvasElement): void {
  canvas.dispatchEvent(new Event('webglcontextrestored'))
}

describe('FrameLoop (spec §9.4(4))', () => {
  it('counts frames and averages FPS over the monotonic clock', () => {
    const clock = new FakeClock()
    const scheduler = new FakeFrameScheduler()
    let frames = 0
    const loop = new FrameLoop({
      clock,
      scheduler,
      onFrame: () => {
        frames += 1
      },
    })

    loop.start()
    expect(loop.fps).toBe(0)
    for (let index = 0; index < 4; index += 1) {
      clock.advance(1000 / 30)
      scheduler.runFrame()
    }

    expect(loop.frameCounter).toBe(4)
    expect(frames).toBe(4)
    expect(loop.fps).toBeCloseTo(30, 5)

    loop.stop()
    scheduler.runFrame()
    expect(loop.frameCounter).toBe(4)
  })
})

describe('WebGlContextTracker (spec §9.4(4), §11 fault matrix)', () => {
  it('keeps the context restorable, requests it back and logs every attempt', () => {
    const clock = new FakeClock()
    const timers = new FakeTimers(clock)
    const log = new RendererLog(clock)
    let restoreCalls = 0
    const tracker = new WebGlContextTracker({
      log,
      timers,
      restoreDelayMs: 1_000,
      getLoseContextExtension: () => ({
        restoreContext: () => {
          restoreCalls += 1
        },
      }),
    })
    const canvas = document.createElement('canvas')
    tracker.attach(canvas)

    const event = loseContext(canvas)
    // Without preventDefault the browser never fires `webglcontextrestored`.
    expect(event.defaultPrevented).toBe(true)
    expect(tracker.lost).toBe(true)
    expect(tracker.lossCount).toBe(1)

    timers.advance(1_000)
    expect(restoreCalls).toBe(1)
    expect(tracker.restoreAttempts).toBe(1)

    // It keeps asking while the context stays lost.
    timers.advance(2_000)
    expect(tracker.restoreAttempts).toBe(3)

    restoreContext(canvas)
    expect(tracker.lost).toBe(false)
    expect(tracker.restoredCount).toBe(1)

    timers.advance(5_000)
    expect(tracker.restoreAttempts).toBe(3)

    const codes = log.entries().map((entry) => entry.code)
    expect(codes).toContain('webgl_context_lost')
    expect(codes).toContain('webgl_restore_requested')
    expect(codes).toContain('webgl_context_restored')

    tracker.detach()
    loseContext(canvas)
    expect(tracker.lossCount).toBe(1)
  })

  it('records the attempt even when the restore extension is unavailable', () => {
    const clock = new FakeClock()
    const timers = new FakeTimers(clock)
    const log = new RendererLog(clock)
    const tracker = new WebGlContextTracker({
      log,
      timers,
      restoreDelayMs: 500,
      getLoseContextExtension: () => null,
    })
    const canvas = document.createElement('canvas')
    tracker.attach(canvas)

    loseContext(canvas)
    timers.advance(500)

    expect(tracker.restoreAttempts).toBe(0)
    expect(log.entries().some((entry) => entry.code === 'webgl_restore_unavailable')).toBe(true)
    tracker.detach()
  })
})

describe('renderer_health during a context loss', () => {
  it('reports the lost context to the server and clears it after a restore', () => {
    const clock = new FakeClock()
    const timers = new FakeTimers(clock)
    const scheduler = new FakeFrameScheduler()
    const sockets = createFakeSocketFactory()
    const runtime = createRuntime({
      search: '',
      clock,
      timers,
      frameScheduler: scheduler,
      socketFactory: sockets.factory,
      random: sequenceRandom([0.5]),
      generateRendererId: () => 'renderer-test',
      webglRestoreDelayMs: 1_000,
    })
    runtime.start()

    const canvas = document.createElement('canvas')
    runtime.webgl.attach(canvas)

    const socket = sockets.last()
    socket.emitOpen()
    scheduler.runFrame(2)

    loseContext(canvas)
    timers.advance(1_000)

    const afterLoss = (socket.parsedSent() as RendererToServerMessage[]).filter(
      (message) => message.type === 'renderer_health',
    )
    expect(afterLoss[afterLoss.length - 1]).toMatchObject({ webglContextLost: true })
    // jsdom has no WebGL context, so the restore path reports that it could not
    // ask for one back — the attempt is still recorded.
    expect(runtime.log.entries().some((entry) => entry.code === 'webgl_context_lost')).toBe(true)

    restoreContext(canvas)
    timers.advance(1_000)

    const afterRestore = (socket.parsedSent() as RendererToServerMessage[]).filter(
      (message) => message.type === 'renderer_health',
    )
    expect(afterRestore[afterRestore.length - 1]).toMatchObject({ webglContextLost: false })

    runtime.stop()
  })
})
