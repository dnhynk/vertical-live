import { describe, expect, it } from 'vitest'

import { DEFAULT_WORLD_TUNING } from '../world/content/tuning.js'
import { initialWorldState } from '../world/reducer.js'
import { EngineStateError, parseEngineState, serializeEngineState } from './state.js'

/**
 * The durable domain state (migration 003). A misread here would silently reset
 * the creature's history, which spec §6.3 forbids as firmly as it forbids death,
 * so every failure mode is a throw and never a fallback to a fresh world.
 */

function sampleWorld(): ReturnType<typeof initialWorldState> {
  return initialWorldState({
    seed: 'seed_test_state',
    startedAt: '2026-08-16T00:00:00.000Z',
    tuning: DEFAULT_WORLD_TUNING,
  })
}

describe('engine state', () => {
  it('round-trips through JSON without losing the world', () => {
    const world = sampleWorld()
    const serialized = JSON.parse(
      JSON.stringify(serializeEngineState(world, 'aggregate')),
    ) as unknown

    const restored = parseEngineState(serialized)
    expect(restored.inputMode).toBe('aggregate')
    expect(restored.world).toEqual(world)
    expect(restored.world.world.seed).toBe('seed_test_state')
    expect(restored.world.world.deadlines.length).toBeGreaterThan(0)
  })

  it('refuses a version it did not write', () => {
    expect(() => parseEngineState({ version: 2, world: {}, inputMode: 'direct' })).toThrow(
      EngineStateError,
    )
  })

  it('refuses a value that is not the shape of a world', () => {
    const world = sampleWorld()
    expect(() => parseEngineState(null)).toThrow(EngineStateError)
    expect(() => parseEngineState({ version: 1, world: {}, inputMode: 'direct' })).toThrow(
      EngineStateError,
    )
    expect(() =>
      parseEngineState({ ...serializeEngineState(world, 'direct'), inputMode: 'sideways' }),
    ).toThrow(EngineStateError)
  })

  it('refuses a world whose audit rings are missing', () => {
    const world = sampleWorld()
    const broken = {
      ...serializeEngineState(world, 'direct'),
      world: { world: world.world, audit: {} },
    }

    expect(() => parseEngineState(broken)).toThrow(/pendingThanks/)
  })
})
