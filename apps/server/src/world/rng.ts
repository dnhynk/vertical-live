/**
 * Seeded, dependency-free pseudo random numbers (TASK_SPECS §T7: "RNG는 시드
 * 주입"). Determinism is a product requirement, not a convenience: spec §10.2
 * makes the server the authority of a state that must be replayable from the
 * inbox, so two runs over the same inputs have to draw the same numbers.
 *
 * `Rng` is a small mutable generator. The reducer never keeps one across steps —
 * `createStepRng` derives a fresh generator from (world seed, step index, input
 * identity), so replay reproduces every draw without persisting a cursor.
 */

export interface Rng {
  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number
  /** Uniform float in [0, 1). */
  nextFloat(): number
  /** Uniform integer in [0, maxExclusive). Returns 0 when the bound is < 1. */
  nextInt(maxExclusive: number): number
  /** Uniform choice. Returns `null` for an empty list. */
  pick<T>(items: readonly T[]): T | null
  /** Weighted choice; non-positive weights are ignored. Returns `null` if none. */
  pickWeighted<T>(items: readonly T[], weightOf: (item: T) => number): T | null
}

/** FNV-1a, 32 bit. Only used to fold a seed string into a numeric state. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * mulberry32. Chosen because it is 8 lines of integer arithmetic with no
 * dependency, passes the usual smoke statistics for content selection, and is
 * trivially reimplementable — the state engine (T8) must be able to reproduce a
 * sequence from a persisted seed alone.
 */
export function createRng(seed: string | number): Rng {
  let state = (typeof seed === 'number' ? seed >>> 0 : hashSeed(seed)) >>> 0

  const nextUint32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return (mixed ^ (mixed >>> 14)) >>> 0
  }

  const nextFloat = (): number => nextUint32() / 0x1_0000_0000

  return {
    nextUint32,
    nextFloat,
    nextInt(maxExclusive) {
      if (!Number.isFinite(maxExclusive) || maxExclusive < 1) return 0
      return Math.floor(nextFloat() * Math.floor(maxExclusive))
    },
    pick(items) {
      if (items.length === 0) return null
      return items[Math.floor(nextFloat() * items.length)] ?? null
    },
    pickWeighted(items, weightOf) {
      let total = 0
      for (const item of items) {
        const weight = weightOf(item)
        if (weight > 0) total += weight
      }
      if (total <= 0) return null
      let target = nextFloat() * total
      for (const item of items) {
        const weight = weightOf(item)
        if (weight <= 0) continue
        target -= weight
        if (target < 0) return item
      }
      return items[items.length - 1] ?? null
    },
  }
}

/**
 * The generator for one reducer step. The step index and the input identity are
 * folded into the seed so that (a) two different inputs at the same state draw
 * different numbers and (b) a replay of the same inbox reproduces both.
 */
export function createStepRng(seed: string, stepIndex: number, inputKey: string): Rng {
  return createRng(`${seed}#${String(stepIndex)}#${inputKey}`)
}
