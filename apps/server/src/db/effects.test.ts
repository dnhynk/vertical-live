import { afterEach, describe, expect, it } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import { EffectNotPublishedError, UnknownEffectError } from './errors.js'
import { makeDeadlineEffect, makePaidEffect, makeSnapshot } from './testing/fixtures.js'
import { createTempStore, type TempStore } from './testing/temp-store.js'

/**
 * Effect outbox bookkeeping (spec §7.3(6)(7)): published, acked or expired, and
 * what a restart has to republish.
 */

let temp: TempStore | undefined

afterEach(() => {
  temp?.dispose()
  temp = undefined
})

function openWithEffect(effectId = 'eff_test_0001'): { handle: TempStore; clock: FakeClock } {
  const clock = new FakeClock()
  temp = createTempStore({ clock })
  temp.store.commitStateTransition({
    snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 0 }),
    revision: 1,
    processedSeq: 0,
    effects: [makePaidEffect({ effectId, stateRevision: 1 })],
  })
  return { handle: temp, clock }
}

describe('markEffectPublished', () => {
  it('records the publish once and reports a repeat', () => {
    const { handle } = openWithEffect()
    expect(handle.store.markEffectPublished('eff_test_0001', '2026-08-16T00:05:01.000Z')).toBe(
      'recorded',
    )
    expect(handle.store.markEffectPublished('eff_test_0001', '2026-08-16T00:05:02.000Z')).toBe(
      'already_published',
    )
    expect(handle.store.getEffect('eff_test_0001')?.publishedAt).toBe('2026-08-16T00:05:01.000Z')
  })

  it('rejects an unknown effect id', () => {
    const { handle } = openWithEffect()
    expect(() => handle.store.markEffectPublished('eff_test_missing')).toThrow(UnknownEffectError)
  })

  it('defaults the instant to the injected clock', () => {
    const { handle, clock } = openWithEffect()
    handle.store.markEffectPublished('eff_test_0001')
    expect(handle.store.getEffect('eff_test_0001')?.publishedAt).toBe(clock.nowUtcIso())
  })
})

describe('markEffectAcked', () => {
  it('records the renderer ACK once', () => {
    const { handle } = openWithEffect()
    handle.store.markEffectPublished('eff_test_0001', '2026-08-16T00:05:01.000Z')
    expect(handle.store.markEffectAcked('eff_test_0001', '2026-08-16T00:05:02.000Z')).toBe(
      'recorded',
    )
    expect(handle.store.markEffectAcked('eff_test_0001', '2026-08-16T00:05:03.000Z')).toBe(
      'already_acked',
    )
    expect(handle.store.getEffect('eff_test_0001')?.ackedAt).toBe('2026-08-16T00:05:02.000Z')
    expect(handle.store.listUnackedEffects()).toEqual([])
  })

  it('refuses an ACK for an effect that was never published', () => {
    const { handle } = openWithEffect()
    expect(() => handle.store.markEffectAcked('eff_test_0001')).toThrow(EffectNotPublishedError)
    expect(handle.store.getEffect('eff_test_0001')?.ackedAt).toBeNull()
  })

  it('rejects an unknown effect id', () => {
    const { handle } = openWithEffect()
    expect(() => handle.store.markEffectAcked('eff_test_missing')).toThrow(UnknownEffectError)
  })

  it('still records a late ACK after the expiry was noted', () => {
    const { handle } = openWithEffect()
    handle.store.markEffectPublished('eff_test_0001', '2026-08-16T00:05:01.000Z')
    handle.store.markEffectExpired('eff_test_0001', '2026-08-16T00:05:07.000Z')
    // The ACK is ground truth that the effect ran on a real frame; `expired_at`
    // is only the server's own timeout note (spec §7.3(7)).
    expect(handle.store.markEffectAcked('eff_test_0001', '2026-08-16T00:05:08.000Z')).toBe(
      'recorded',
    )
    const row = handle.store.getEffect('eff_test_0001')
    expect(row?.ackedAt).toBe('2026-08-16T00:05:08.000Z')
    expect(row?.expiredAt).toBe('2026-08-16T00:05:07.000Z')
  })
})

describe('markEffectExpired', () => {
  it('records the expiry once', () => {
    const { handle } = openWithEffect()
    expect(handle.store.markEffectExpired('eff_test_0001', '2026-08-16T00:05:07.000Z')).toBe(
      'recorded',
    )
    expect(handle.store.markEffectExpired('eff_test_0001', '2026-08-16T00:05:08.000Z')).toBe(
      'already_expired',
    )
    expect(handle.store.getEffect('eff_test_0001')?.expiredAt).toBe('2026-08-16T00:05:07.000Z')
    expect(handle.store.listUnackedEffects()).toEqual([])
  })

  it('leaves an already acked effect alone', () => {
    const { handle } = openWithEffect()
    handle.store.markEffectPublished('eff_test_0001', '2026-08-16T00:05:01.000Z')
    handle.store.markEffectAcked('eff_test_0001', '2026-08-16T00:05:02.000Z')
    expect(handle.store.markEffectExpired('eff_test_0001')).toBe('already_acked')
    expect(handle.store.getEffect('eff_test_0001')?.expiredAt).toBeNull()
  })

  it('rejects an unknown effect id', () => {
    const { handle } = openWithEffect()
    expect(() => handle.store.markEffectExpired('eff_test_missing')).toThrow(UnknownEffectError)
  })
})

describe('listUnackedEffects', () => {
  it('crash window "after the effect was recorded, before the ACK" keeps the row', () => {
    const { handle } = openWithEffect('eff_test_pending')
    handle.store.markEffectPublished('eff_test_pending', '2026-08-16T00:05:01.000Z')

    // A restart between publish and ACK: the effect must come back so it is
    // republished exactly once (spec §7.3(7), §11 유료 무결성).
    const reopened = handle.reopen()
    const open = reopened.listUnackedEffects()
    expect(open).toHaveLength(1)
    expect(open[0]?.effect.effectId).toBe('eff_test_pending')
    expect(open[0]?.effect.paid).toBe(true)
    expect(open[0]?.publishedAt).toBe('2026-08-16T00:05:01.000Z')
    expect(open[0]?.ackedAt).toBeNull()
  })

  it('includes an effect that was committed but never published', () => {
    const { handle } = openWithEffect('eff_test_unpublished')
    expect(handle.store.listUnackedEffects().map((row) => row.effect.effectId)).toEqual([
      'eff_test_unpublished',
    ])
  })

  it('rebuilds the contract object from the stored columns', () => {
    const { handle } = openWithEffect('eff_test_roundtrip')
    expect(handle.store.getEffect('eff_test_roundtrip')?.effect).toEqual(
      makePaidEffect({ effectId: 'eff_test_roundtrip', stateRevision: 1 }),
    )
  })
})

describe('effect cause (BOARD A-17)', () => {
  it('round-trips a timer-caused effect with a null event key', () => {
    const clock = new FakeClock()
    temp = createTempStore({ clock })
    const effect = makeDeadlineEffect({
      effectId: 'eff_test_timer',
      deadlineId: 'dl_test_choice',
      stateRevision: 1,
    })
    temp.store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 0 }),
      revision: 1,
      processedSeq: 0,
      effects: [effect],
    })

    // Content moves with no viewers and no event to point at (spec §2.1, §6.2).
    const reopened = temp.reopen()
    const stored = reopened.getEffect('eff_test_timer')
    expect(stored?.effect).toEqual(effect)
    expect(stored?.effect.causedByEventKey).toBeNull()
    expect(reopened.listUnackedEffects().map((row) => row.effect.effectId)).toEqual([
      'eff_test_timer',
    ])
  })

  it('round-trips a timer-caused effect that names no deadline row', () => {
    temp = createTempStore()
    const effect = makeDeadlineEffect({ effectId: 'eff_test_timer_anon', stateRevision: 1 })
    temp.store.commitStateTransition({
      snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 0 }),
      revision: 1,
      processedSeq: 0,
      effects: [effect],
    })
    expect(temp.store.getEffect('eff_test_timer_anon')?.effect).toEqual(effect)
  })

  it('refuses a paid effect that claims a deadline cause', () => {
    temp = createTempStore()
    // Rejected twice over: the contract refinement and the table CHECK. A paid
    // row is a durable audit record and must name its event (spec §8.4, §10.2).
    expect(() =>
      temp?.store.commitStateTransition({
        snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 0 }),
        revision: 1,
        processedSeq: 0,
        effects: [
          {
            ...makePaidEffect({ effectId: 'eff_test_paid_timer', stateRevision: 1 }),
            cause: { kind: 'deadline', deadlineKind: 'test_choice_window' },
            causedByEventKey: null,
          } as ReturnType<typeof makePaidEffect>,
        ],
      }),
    ).toThrow()
    expect(temp.store.loadRecoveryState().unackedEffects).toEqual([])
  })

  it('refuses an event cause whose key disagrees with causedByEventKey', () => {
    temp = createTempStore()
    expect(() =>
      temp?.store.commitStateTransition({
        snapshot: makeSnapshot({ stateRevision: 1, processedIngestSeq: 0 }),
        revision: 1,
        processedSeq: 0,
        effects: [
          {
            ...makePaidEffect({ effectId: 'eff_test_mismatch', stateRevision: 1 }),
            causedByEventKey: 'youtube:brd_test_0001:msg_test_other',
          } as ReturnType<typeof makePaidEffect>,
        ],
      }),
    ).toThrow()
    expect(temp.store.loadRecoveryState().unackedEffects).toEqual([])
  })
})
