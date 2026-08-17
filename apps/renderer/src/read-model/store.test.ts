import { describe, expect, it } from 'vitest'

import { FakeClock } from '../testing/fakes'
import { sampleActionEffect, samplePaidThanksEffect, sampleSnapshot } from '../testing/fixtures'
import { RendererLog } from './log'
import { ReadModel, type AckSink } from './store'

interface Harness {
  clock: FakeClock
  log: RendererLog
  model: ReadModel
  stateAcks: { stateRevision: number; appliedAt: string }[]
  effectAcks: { effectId: string; appliedAt: string }[]
}

function createHarness(
  options: { effectRetentionMs?: number; maxRememberedEffects?: number } = {},
): Harness {
  const clock = new FakeClock()
  const log = new RendererLog(clock)
  const model = new ReadModel({ clock, log, ...options })
  const stateAcks: Harness['stateAcks'] = []
  const effectAcks: Harness['effectAcks'] = []
  const sink: AckSink = {
    ackState: (stateRevision, appliedAt) => stateAcks.push({ stateRevision, appliedAt }),
    ackEffect: (effectId, appliedAt) => effectAcks.push({ effectId, appliedAt }),
  }
  model.setAckSink(sink)
  return { clock, log, model, stateAcks, effectAcks }
}

describe('ReadModel snapshots (spec §7.3(6)(7), §10.2)', () => {
  it('replaces the snapshot wholesale and only acks after a committed frame', () => {
    const harness = createHarness()

    expect(harness.model.receiveSnapshot(sampleSnapshot({ stateRevision: 7 }))).toBe('applied')
    expect(harness.model.snapshot?.stateRevision).toBe(7)
    expect(harness.stateAcks).toEqual([])

    // A frame without a commit acks nothing: React has not drawn it yet.
    harness.model.markFramePresented()
    expect(harness.stateAcks).toEqual([])

    harness.model.markCommitted()
    expect(harness.stateAcks).toEqual([])

    harness.model.markFramePresented()
    expect(harness.stateAcks).toEqual([{ stateRevision: 7, appliedAt: '2026-08-17T00:00:00.000Z' }])
    expect(harness.model.lastAppliedStateRevision).toBe(7)
  })

  it('does not ack the same revision twice', () => {
    const harness = createHarness()
    harness.model.receiveSnapshot(sampleSnapshot({ stateRevision: 3 }))
    harness.model.markCommitted()
    harness.model.markFramePresented()
    harness.model.markCommitted()
    harness.model.markFramePresented()
    expect(harness.stateAcks).toHaveLength(1)
  })

  it('drops a snapshot older than the newest one it holds', () => {
    const harness = createHarness()
    harness.model.receiveSnapshot(sampleSnapshot({ stateRevision: 9 }))
    harness.model.markCommitted()
    harness.model.markFramePresented()

    expect(harness.model.receiveSnapshot(sampleSnapshot({ stateRevision: 8 }))).toBe('stale')
    expect(harness.model.snapshot?.stateRevision).toBe(9)

    harness.model.markCommitted()
    harness.model.markFramePresented()
    expect(harness.stateAcks).toHaveLength(1)
    expect(harness.log.entries().some((entry) => entry.code === 'snapshot_stale')).toBe(true)
  })

  it('starts empty, so a refresh recovers from the server snapshot alone', () => {
    const harness = createHarness()
    expect(harness.model.snapshot).toBeNull()
    expect(harness.model.lastAppliedStateRevision).toBeNull()
    expect(harness.model.activeEffects).toEqual([])
  })
})

describe('ReadModel effects (spec §7.3(7), §9.2)', () => {
  it('starts an effectId once and acks a resend without replaying it', () => {
    const harness = createHarness()
    const effect = sampleActionEffect()

    expect(harness.model.receiveEffect(effect)).toBe('started')
    expect(harness.model.effectStartCount).toBe(1)
    expect(harness.model.activeEffects).toHaveLength(1)

    harness.model.markCommitted()
    harness.model.markFramePresented()
    expect(harness.effectAcks.map((ack) => ack.effectId)).toEqual(['sample-effect-action-1'])

    expect(harness.model.receiveEffect(effect)).toBe('repeat')
    expect(harness.model.effectStartCount).toBe(1)
    expect(harness.model.activeEffects).toHaveLength(1)

    harness.model.markCommitted()
    harness.model.markFramePresented()
    // The server only resends when it holds no ACK, so the ACK is repeated.
    expect(harness.effectAcks).toHaveLength(2)
    expect(harness.model.effectStartCount).toBe(1)
  })

  it('keeps a paid effect out of the game state and only plays it once', () => {
    const harness = createHarness()
    const paid = samplePaidThanksEffect()
    expect(harness.model.receiveEffect(paid)).toBe('started')
    expect(harness.model.receiveEffect(paid)).toBe('repeat')
    expect(harness.model.effectStartCount).toBe(1)
    expect(harness.model.snapshot).toBeNull()
  })

  it('does not play or ack an effect whose window already closed', () => {
    const harness = createHarness()
    harness.clock.advance(10_000)

    expect(harness.model.receiveEffect(sampleActionEffect())).toBe('expired')
    expect(harness.model.effectStartCount).toBe(0)
    expect(harness.model.activeEffects).toEqual([])

    harness.model.markCommitted()
    harness.model.markFramePresented()
    expect(harness.effectAcks).toEqual([])
    expect(harness.log.entries().some((entry) => entry.code === 'effect_window_closed')).toBe(true)
  })

  it('waits for the start time before showing and acking a scheduled effect', () => {
    const harness = createHarness()
    const scheduled = sampleActionEffect({
      effectId: 'sample-effect-action-2',
      startsAt: '2026-08-17T00:00:04.000Z',
      endsAt: '2026-08-17T00:00:08.000Z',
    })

    expect(harness.model.receiveEffect(scheduled)).toBe('started')
    expect(harness.model.activeEffects).toEqual([])

    harness.model.markCommitted()
    harness.model.markFramePresented()
    expect(harness.effectAcks).toEqual([])

    harness.clock.advance(4_000)
    harness.model.markFramePresented()
    expect(harness.model.activeEffects).toHaveLength(1)
    expect(harness.effectAcks.map((ack) => ack.effectId)).toEqual(['sample-effect-action-2'])
  })

  it('reports the effect as expired instead of acking it when it is never drawn', () => {
    const harness = createHarness()
    harness.model.receiveEffect(sampleActionEffect())
    harness.model.markCommitted()

    harness.clock.advance(10_000)
    harness.model.markFramePresented()

    expect(harness.effectAcks).toEqual([])
    expect(
      harness.log.entries().some((entry) => entry.code === 'effect_expired_before_frame'),
    ).toBe(true)
  })

  it('remembers a finished effect id for the retention window and forgets it after', () => {
    const harness = createHarness({ effectRetentionMs: 1_000 })
    const closedLogs = (): number =>
      harness.log.entries().filter((entry) => entry.code === 'effect_window_closed').length

    harness.model.receiveEffect(sampleActionEffect())
    harness.model.markCommitted()
    harness.model.markFramePresented()

    // The 5s window is over but the id is still remembered: a resend is known.
    harness.clock.advance(5_500)
    harness.model.markFramePresented()
    expect(harness.model.receiveEffect(sampleActionEffect())).toBe('expired')
    expect(closedLogs()).toBe(0)

    // Past window + retention the id is dropped, so the same resend is seen as
    // an unknown effect whose window has closed.
    harness.clock.advance(2_000)
    harness.model.markFramePresented()
    expect(harness.model.receiveEffect(sampleActionEffect())).toBe('expired')
    expect(closedLogs()).toBe(1)
  })

  it('does not grow without bound while a broadcast runs for days', () => {
    const harness = createHarness({ effectRetentionMs: 60_000, maxRememberedEffects: 4 })
    for (let index = 0; index < 20; index += 1) {
      harness.model.receiveEffect(
        sampleActionEffect({
          effectId: `sample-effect-action-${String(index)}`,
          startsAt: '2026-08-17T00:00:00.000Z',
          endsAt: '2026-08-17T00:00:01.000Z',
        }),
      )
      harness.clock.advance(1_000)
      harness.model.markCommitted()
      harness.model.markFramePresented()
    }
    expect(harness.model.activeEffects).toEqual([])
    expect(harness.log.entries().some((entry) => entry.code === 'effect_memory_pruned')).toBe(true)
  })
})
