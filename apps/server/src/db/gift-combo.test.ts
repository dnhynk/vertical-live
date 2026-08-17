import { effectiveGiftCount } from '@vl/contract'
import { afterEach, describe, expect, it } from 'vitest'

import { PersistenceInvariantError } from './errors.js'
import { giftBaseKey, giftKey, grpcEnvelope } from './testing/fixtures.js'
import { createTempStore, type TempStore } from './testing/temp-store.js'

/**
 * Gift combo folding (spec §7.4): `effectiveCount = comboCount > 0 ? comboCount : 1`,
 * `delta = max(0, effectiveCount - storedMax)`, `storedMax` never decreases.
 */

let temp: TempStore | undefined

afterEach(() => {
  temp?.dispose()
  temp = undefined
})

function open(): TempStore {
  temp = createTempStore()
  return temp
}

describe('upsertGiftMax', () => {
  it('yields deltas 1, 0, 2, 2, 0 for the combo sequence 0 → 1 → 3 → 5 → 3', () => {
    const { store } = open()
    const baseKey = giftBaseKey()

    // The reported `comboCount` sequence from TASK_SPECS §T4 합격 기준 2. The
    // non-combo gift reports 0 and still counts as the first one.
    const deltas = [0, 1, 3, 5, 3].map(
      (comboCount) => store.upsertGiftMax(baseKey, effectiveGiftCount(comboCount)).delta,
    )

    expect(deltas).toEqual([1, 0, 2, 2, 0])
    // The late lower count did not rewind the maximum.
    expect(store.getGiftStoredMax(baseKey)).toBe(5)
  })

  it('reports the maximum it folded into, not just the delta', () => {
    const { store } = open()
    const baseKey = giftBaseKey()
    expect(store.upsertGiftMax(baseKey, 3)).toEqual({
      baseKey,
      effectiveCount: 3,
      previousMax: 0,
      storedMax: 3,
      delta: 3,
    })
    expect(store.upsertGiftMax(baseKey, 2)).toEqual({
      baseKey,
      effectiveCount: 2,
      previousMax: 3,
      storedMax: 3,
      delta: 0,
    })
  })

  it('keeps a maximum per base key', () => {
    const { store } = open()
    store.upsertGiftMax(giftBaseKey('msg_test_gift_0001'), 4)
    expect(store.upsertGiftMax(giftBaseKey('msg_test_gift_0002'), 1).delta).toBe(1)
    expect(store.getGiftStoredMax(giftBaseKey('msg_test_gift_0001'))).toBe(4)
  })

  it('rejects a full gift event key, which would defeat the shared maximum', () => {
    const { store } = open()
    expect(() => store.upsertGiftMax(giftKey(3), 3)).toThrow(PersistenceInvariantError)
    expect(store.getGiftStoredMax(giftKey(3))).toBe(0)
  })

  it('rejects a key that is not an event key and a non-positive count', () => {
    const { store } = open()
    expect(() => store.upsertGiftMax('not an event key', 1)).toThrow()
    expect(() => store.upsertGiftMax(giftBaseKey(), 0)).toThrow(PersistenceInvariantError)
    expect(() => store.upsertGiftMax(giftBaseKey(), 1.5)).toThrow(PersistenceInvariantError)
  })

  it('derives the same effective counts from the committed gift fixtures', () => {
    // Guards the assumption the delta sequence above rests on: the contract
    // fixtures for comboCount 0 and 1 both mean "the first gift".
    const counts = [
      'gift-event-combo-0',
      'gift-event-combo-1',
      'gift-event-combo-3',
      'gift-event-combo-5',
    ].map((name) => {
      const envelope = grpcEnvelope(name)
      if (envelope.validationStatus !== 'valid') throw new Error(`${name} did not validate`)
      return effectiveGiftCount(envelope.payment?.comboCount ?? null)
    })
    expect(counts).toEqual([1, 1, 3, 5])
  })
})
