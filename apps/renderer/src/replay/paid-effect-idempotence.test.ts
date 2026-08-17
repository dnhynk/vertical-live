import { openSession, type SimulatorSession } from '@vl/simulator'
import { findBuiltinScenario } from '@vl/simulator/scenario'
import { afterEach, describe, expect, it } from 'vitest'

import type { Clock } from '../read-model/clock'
import { RendererLog } from '../read-model/log'
import { ReadModel } from '../read-model/store'

/**
 * The renderer half of spec §11 유료 무결성:
 *
 * > 같은 paid `effectId`가 재전송돼도 연출을 재시작하지 않음.
 *
 * `tools/simulator/src/replay/paid-integrity.test.ts` proves the server half —
 * one Super Chat is applied once and the writer really does retransmit the same
 * `effectId`. That test cannot prove this half: it only had the stub renderer's
 * own `Set`, so a regression that restarted repeated effects in the real
 * renderer would have stayed green (review round 1, M2).
 *
 * This test closes it. A real backend plays the `paid-replay` scenario over real
 * HTTP with a renderer that deliberately does not acknowledge effects, so the
 * engine keeps retransmitting the open ones (spec §7.3(7)); the frames it
 * actually put on the wire are then replayed, in arrival order and at their
 * arrival instants, through the **production** `ReadModel`.
 *
 * It lives in `apps/renderer` because that is where the production read model
 * can be imported: the renderer compiles with `moduleResolution: "Bundler"` and
 * extensionless relative imports, which a `NodeNext` project like
 * `tools/simulator` cannot resolve. `npm run test:replay` runs this directory
 * together with the simulator's.
 */

let session: SimulatorSession | null = null

afterEach(async () => {
  await session?.close()
  session = null
})

/** A clock the test drives to each frame's arrival instant. */
class ReplayClock implements Clock {
  #wallMs = 0

  set(atUtc: string): void {
    this.#wallMs = Date.parse(atUtc)
  }

  monotonicMs(): number {
    return this.#wallMs
  }

  wallMs(): number {
    return this.#wallMs
  }

  nowIso(): string {
    return new Date(this.#wallMs).toISOString()
  }
}

describe('§11 유료 무결성 — the production read model does not restart a retransmitted effect', () => {
  it('starts each retransmitted paid effect exactly once', async () => {
    const scenario = findBuiltinScenario('paid-replay')
    if (scenario === null) throw new Error('missing built-in scenario paid-replay')

    // No effect ACKs, so every published effect stays open and the engine
    // retransmits it on the interval (spec §7.3(7)).
    session = await openSession({ rendererAckEffects: false, sliceMs: 1_000 })
    await session.run(scenario)
    const observed = session.renderer?.effectLog ?? []
    const paid = observed.filter((frame) => frame.effect.paid)
    const distinctPaidIds = new Set(paid.map((frame) => frame.effect.effectId))

    // The premise: the server really did send the same paid effect more than
    // once. Without this the assertions below would pass vacuously.
    expect(distinctPaidIds.size).toBeGreaterThan(0)
    expect(paid.length).toBeGreaterThan(distinctPaidIds.size)

    const clock = new ReplayClock()
    const model = new ReadModel({ clock, log: new RendererLog(clock) })
    const outcomes = new Map<string, string[]>()
    for (const frame of observed) {
      clock.set(frame.atUtc)
      const outcome = model.receiveEffect(frame.effect)
      const previous = outcomes.get(frame.effect.effectId) ?? []
      previous.push(outcome)
      outcomes.set(frame.effect.effectId, previous)
    }

    // Every paid effect started exactly once. A later copy is either a `repeat`
    // or, if the retransmission outlived the effect's own window, `expired` —
    // both change nothing on screen, and neither is a second start, which is
    // what spec §11 forbids (§7.3(7)).
    for (const effectId of distinctPaidIds) {
      const results = outcomes.get(effectId) ?? []
      expect(results.filter((outcome) => outcome === 'started')).toHaveLength(1)
      expect(results.slice(1).includes('started')).toBe(false)
      expect(results.slice(1).every((o) => o === 'repeat' || o === 'expired')).toBe(true)
    }
    // And the model's own counter agrees: one staging per id it ever started,
    // however many frames carried them.
    const started = [...outcomes.values()].filter((results) => results.includes('started'))
    expect(model.effectStartCount).toBe(started.length)
    expect(observed.length).toBeGreaterThan(model.effectStartCount)
  }, 180_000)

  it('does not restart an effect that is replayed after a reconnect', async () => {
    const scenario = findBuiltinScenario('paid-replay')
    if (scenario === null) throw new Error('missing built-in scenario paid-replay')

    session = await openSession({ rendererAckEffects: false, sliceMs: 1_000 })
    await session.run(scenario)
    const observed = session.renderer?.effectLog ?? []
    const firstPaid = observed.find((frame) => frame.effect.paid)
    if (firstPaid === undefined) throw new Error('expected a paid effect frame')

    const clock = new ReplayClock()
    const model = new ReadModel({ clock, log: new RendererLog(clock) })
    clock.set(firstPaid.atUtc)

    expect(model.receiveEffect(firstPaid.effect)).toBe('started')
    // The same frame again, as a reconnect republish would deliver it.
    expect(model.receiveEffect(firstPaid.effect)).toBe('repeat')
    expect(model.receiveEffect(firstPaid.effect)).toBe('repeat')
    expect(model.effectStartCount).toBe(1)
  }, 180_000)
})
