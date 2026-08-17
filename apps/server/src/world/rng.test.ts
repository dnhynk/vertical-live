import { describe, expect, it } from 'vitest'

import { createRng, createStepRng, hashSeed } from './rng.js'

describe('seeded generator', () => {
  it('produces the same sequence for the same seed', () => {
    const draw = (seed: string): number[] =>
      Array.from({ length: 20 }, () => createRng(seed).nextUint32())
    expect(draw('seed_test_1')).toEqual(draw('seed_test_1'))

    const a = createRng('seed_test_1')
    const b = createRng('seed_test_1')
    expect(Array.from({ length: 20 }, () => a.nextUint32())).toEqual(
      Array.from({ length: 20 }, () => b.nextUint32()),
    )
  })

  it('produces a different sequence for a different seed', () => {
    const a = createRng('seed_test_1')
    const b = createRng('seed_test_2')
    expect(Array.from({ length: 20 }, () => a.nextUint32())).not.toEqual(
      Array.from({ length: 20 }, () => b.nextUint32()),
    )
  })

  it('keeps floats in [0, 1) and integers in range', () => {
    const rng = createRng('seed_test_range')
    for (let index = 0; index < 500; index += 1) {
      const value = rng.nextFloat()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
      expect(rng.nextInt(7)).toBeLessThan(7)
      expect(rng.nextInt(7)).toBeGreaterThanOrEqual(0)
    }
    expect(rng.nextInt(0)).toBe(0)
    expect(rng.nextInt(Number.NaN)).toBe(0)
  })

  it('returns null for an empty pick and covers a non-empty one', () => {
    const rng = createRng('seed_test_pick')
    expect(rng.pick([])).toBe(null)
    const seen = new Set<string>()
    for (let index = 0; index < 200; index += 1) seen.add(rng.pick(['a', 'b', 'c']) ?? '')
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
  })

  it('respects weights and ignores non-positive ones', () => {
    const rng = createRng('seed_test_weight')
    const counts = new Map<string, number>()
    for (let index = 0; index < 2_000; index += 1) {
      const picked =
        rng.pickWeighted(
          [
            { id: 'heavy', weight: 9 },
            { id: 'light', weight: 1 },
            { id: 'never', weight: 0 },
          ],
          (item) => item.weight,
        )?.id ?? ''
      counts.set(picked, (counts.get(picked) ?? 0) + 1)
    }
    expect(counts.get('never')).toBeUndefined()
    expect(counts.get('heavy') ?? 0).toBeGreaterThan(counts.get('light') ?? 0)
    expect(rng.pickWeighted([{ weight: 0 }], (item) => item.weight)).toBe(null)
  })

  it('derives an independent generator per step and input', () => {
    const a = createStepRng('seed_test_world', 7, 'event:simulator:bc_test_1:msg_test_0001')
    const b = createStepRng('seed_test_world', 7, 'event:simulator:bc_test_1:msg_test_0002')
    const c = createStepRng('seed_test_world', 7, 'event:simulator:bc_test_1:msg_test_0001')
    expect(a.nextUint32()).not.toBe(b.nextUint32())
    // The same (seed, step, input) reproduces the same draws.
    expect(c.nextUint32()).toBe(
      createStepRng('seed_test_world', 7, 'event:simulator:bc_test_1:msg_test_0001').nextUint32(),
    )
    expect(
      createStepRng('seed_test_world', 8, 'event:simulator:bc_test_1:msg_test_0001').nextUint32(),
    ).not.toBe(
      createStepRng('seed_test_world', 7, 'event:simulator:bc_test_1:msg_test_0001').nextUint32(),
    )
  })

  it('hashes a seed string to a 32-bit unsigned value', () => {
    expect(hashSeed('a')).toBe(hashSeed('a'))
    expect(hashSeed('a')).not.toBe(hashSeed('b'))
    expect(hashSeed('')).toBeGreaterThanOrEqual(0)
  })
})
