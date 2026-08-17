import { InputModeSchema, type InputMode } from '@vl/contract'

import type { WorldState } from '../world/types.js'

/**
 * The writer's durable domain state (migration 004, `world_snapshot.engine_state_json`).
 *
 * `WorldSnapshot` is the renderer's read model: it carries the four screen slots
 * and the current values, not the seed, the step counter, the need pressures,
 * the variation rings, the paid audit ring or the schedule. Restoring the
 * content director from it is impossible, so the engine persists its own state
 * in the same transaction as the snapshot (spec §7.3(5), §10.2).
 *
 * `version` exists so a future shape change is a migration and not a silent
 * misread: an unknown version stops the engine instead of resetting the world.
 */

export const ENGINE_STATE_VERSION = 1

export interface PersistedEngineState {
  readonly version: typeof ENGINE_STATE_VERSION
  readonly world: WorldState
  /**
   * Mode of the input arbiter at the last commit. A restart resumes it so a
   * running aggregate window is not silently dropped back to `direct` (§6.4).
   */
  readonly inputMode: InputMode
  /**
   * `eventKey → effectId` of every paid thanks whose substitute acknowledgement
   * is still owed (spec §9.2).
   *
   * This is what makes the durable `effect_outbox.acked_at` the authority on
   * whether the original staging reached a frame: the fallback timer resolves the
   * effect id here and asks the outbox, instead of trusting an in-memory queue
   * that a restart or an early-firing deadline could outrun (R-T8-1 blocker 2).
   *
   * Absent in states written before that fix; an absent entry means "cannot prove
   * it played", and spec §9.2 then wants the substitute to run.
   */
  readonly paidThanksEffects: Readonly<Record<string, string>>
}

export class EngineStateError extends Error {
  constructor(message: string) {
    super(`invalid persisted engine state: ${message}`)
    this.name = 'EngineStateError'
  }
}

export function serializeEngineState(
  world: WorldState,
  inputMode: InputMode,
  paidThanksEffects: ReadonlyMap<string, string> = new Map(),
): PersistedEngineState {
  return {
    version: ENGINE_STATE_VERSION,
    world,
    inputMode,
    paidThanksEffects: Object.fromEntries(paidThanksEffects),
  }
}

/**
 * Reads back what this engine wrote. The checks are structural rather than a
 * field-by-field schema: the value is the engine's own output, so the question
 * being asked is "is this the shape this version writes", and the answer must be
 * a hard failure — a world that silently cold-started would lose the creature's
 * history, which spec §6.3 forbids as much as it forbids a death.
 */
export function parseEngineState(value: unknown): PersistedEngineState {
  if (!isRecord(value)) throw new EngineStateError('not an object')
  if (value['version'] !== ENGINE_STATE_VERSION) {
    throw new EngineStateError(
      `version ${String(value['version'])} was written by another engine version (expected ${String(ENGINE_STATE_VERSION)})`,
    )
  }
  const world = value['world']
  if (!isRecord(world)) throw new EngineStateError('world is not an object')
  const game = world['world']
  const audit = world['audit']
  if (!isRecord(game)) throw new EngineStateError('world.world is not an object')
  if (!isRecord(audit)) throw new EngineStateError('world.audit is not an object')
  if (typeof game['seed'] !== 'string' || game['seed'] === '') {
    throw new EngineStateError('world.world.seed is missing')
  }
  if (typeof game['stepIndex'] !== 'number') {
    throw new EngineStateError('world.world.stepIndex is missing')
  }
  if (typeof game['worldTimeUtc'] !== 'string') {
    throw new EngineStateError('world.world.worldTimeUtc is missing')
  }
  if (!isRecord(game['creature'])) throw new EngineStateError('world.world.creature is missing')
  if (!Array.isArray(game['deadlines']))
    throw new EngineStateError('world.world.deadlines is missing')
  if (!Array.isArray(audit['pendingThanks'])) {
    throw new EngineStateError('world.audit.pendingThanks is missing')
  }
  if (!Array.isArray(audit['acknowledgedEventKeys'])) {
    throw new EngineStateError('world.audit.acknowledgedEventKeys is missing')
  }

  const inputMode = InputModeSchema.safeParse(value['inputMode'])
  if (!inputMode.success) throw new EngineStateError('inputMode is not a valid input mode')

  return {
    version: ENGINE_STATE_VERSION,
    world: world as unknown as WorldState,
    inputMode: inputMode.data,
    paidThanksEffects: readStringMap(value['paidThanksEffects']),
  }
}

/**
 * An additive field, so a state written before it existed reads as empty rather
 * than as a version mismatch: the only consequence is that a substitute thanks
 * cannot be proven unnecessary, and §9.2 prefers running it to skipping it.
 */
function readStringMap(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new EngineStateError('paidThanksEffects is not an object')
  const entries: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new EngineStateError(`paidThanksEffects.${key} is not an effect id`)
    }
    entries[key] = entry
  }
  return entries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
