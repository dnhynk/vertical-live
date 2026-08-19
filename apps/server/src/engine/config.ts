import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DEFAULT_WORLD_TUNING, FRESHNESS_MINIMUMS } from '../world/content/tuning.js'
import type { WorldTuning } from '../world/content/tuning.js'

/**
 * Engine settings from `config/default.json` with env overrides (TASK_SPECS
 * 공통 규약).
 *
 * Two things live here that the rest of the engine must not read from a module
 * constant:
 *
 * - the engine's own pacing and degraded thresholds, all **provisional**
 *   (BOARD A-15): spec §7.5 and §9.2 name the behaviours and leave the numbers
 *   to Gate 0/2, so nothing below is a pass line;
 * - the world tuning, which TASK_SPECS §T8 requires be injected into `step()`
 *   from configuration rather than taken from the content module directly. The
 *   file carries the full block and `config.test.ts` pins it to
 *   `DEFAULT_WORLD_TUNING`, so the two can never drift apart in silence while an
 *   operator can still override any single value.
 */

export interface EngineEffectConfig {
  /** How long a published, unacked effect waits before it is sent again. */
  readonly retransmitIntervalMs: number
  /** Grace after `endsAt` before an unacked effect is recorded `expired`. */
  readonly expiryGraceMs: number
}

export interface EngineDegradedConfig {
  /**
   * How long a free command stays applicable after `receivedAt`. Spec §9.2 calls
   * this the pre-approved 유효시간 and leaves the value to the content owner.
   */
  readonly eventValidityMs: number
  /** No renderer ACK for the published revision within this window ⇒ degraded. */
  readonly rendererAckTimeoutMs: number
}

export interface EngineDeadlineConfig {
  /**
   * The largest gap in world time one writer pass walks one deadline occurrence
   * at a time. Past it the gap is downtime and spec §10.2's policies apply
   * instead (`StateEngine`'s catch-up). Provisional (BOARD A-15): spec §10.2
   * names the policies and fixes no window.
   */
  readonly catchUpWindowMs: number
}

export interface EngineConfig {
  /** Seed of the world RNG; fixing it is what makes a replay reproducible. */
  readonly worldSeed: string
  readonly creatureId: string
  /** BOARD A-1: closed in V1. */
  readonly identityGateOpen: boolean
  /** Inbox rows read per drain query. */
  readonly drainBatchSize: number
  /** Idle wake-up interval of the writer loop. */
  readonly tickIntervalMs: number
  readonly effects: EngineEffectConfig
  readonly degraded: EngineDegradedConfig
  readonly deadlines: EngineDeadlineConfig
  /** Samples kept per latency stage for the `/metrics` percentiles. */
  readonly metricsSampleSize: number
  readonly provisional: readonly string[]
}

export interface SimulatorConfig {
  /** `POST /ingest/simulator` returns 404 while this is false (§T11 acceptance 3). */
  readonly enabled: boolean
}

export interface EngineRuntimeConfig {
  readonly engine: EngineConfig
  readonly tuning: WorldTuning
  readonly freshness: typeof FRESHNESS_MINIMUMS
  readonly simulator: SimulatorConfig
}

/** `config/default.json` at the repository root, from `src/engine/` or `dist/engine/`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/default.json', import.meta.url),
)

export class EngineConfigError extends Error {
  constructor(message: string) {
    super(`invalid engine config: ${message}`)
    this.name = 'EngineConfigError'
  }
}

export interface LoadEngineConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadEngineConfig(options: LoadEngineConfigOptions = {}): EngineRuntimeConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new EngineConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }

  const root = readObject(parsed, 'root')
  const section = readObject(root['engine'], 'engine')
  const effects = readObject(section['effects'], 'engine.effects')
  const degraded = readObject(section['degraded'], 'engine.degraded')
  const deadlines = readObject(section['deadlines'], 'engine.deadlines')
  const world = readObject(root['world'], 'world')
  const simulator = readObject(root['simulator'], 'simulator')

  const engine: EngineConfig = Object.freeze({
    worldSeed: readNonEmptyString(env['VL_WORLD_SEED'] ?? section['worldSeed'], 'engine.worldSeed'),
    creatureId: readNonEmptyString(section['creatureId'], 'engine.creatureId'),
    identityGateOpen: readBoolean(
      env['VL_IDENTITY_GATE_OPEN'] ?? section['identityGateOpen'],
      'engine.identityGateOpen',
    ),
    drainBatchSize: readPositiveInt(section['drainBatchSize'], 'engine.drainBatchSize'),
    tickIntervalMs: readPositiveInt(
      env['VL_ENGINE_TICK_MS'] ?? section['tickIntervalMs'],
      'engine.tickIntervalMs',
    ),
    effects: Object.freeze({
      retransmitIntervalMs: readPositiveInt(
        effects['retransmitIntervalMs'],
        'engine.effects.retransmitIntervalMs',
      ),
      expiryGraceMs: readNonNegativeInt(effects['expiryGraceMs'], 'engine.effects.expiryGraceMs'),
    }),
    degraded: Object.freeze({
      eventValidityMs: readPositiveInt(
        env['VL_EVENT_VALIDITY_MS'] ?? degraded['eventValidityMs'],
        'engine.degraded.eventValidityMs',
      ),
      rendererAckTimeoutMs: readPositiveInt(
        degraded['rendererAckTimeoutMs'],
        'engine.degraded.rendererAckTimeoutMs',
      ),
    }),
    deadlines: Object.freeze({
      catchUpWindowMs: readPositiveInt(
        env['VL_DEADLINE_CATCH_UP_MS'] ?? deadlines['catchUpWindowMs'],
        'engine.deadlines.catchUpWindowMs',
      ),
    }),
    metricsSampleSize: readPositiveInt(section['metricsSampleSize'], 'engine.metricsSampleSize'),
    provisional: Object.freeze(readStringArray(section['provisional'], 'engine.provisional')),
  })

  return Object.freeze({
    engine,
    tuning: mergeTuning(DEFAULT_WORLD_TUNING, world['tuning'], 'world.tuning') as WorldTuning,
    freshness: mergeTuning(
      FRESHNESS_MINIMUMS,
      world['freshness'],
      'world.freshness',
    ) as typeof FRESHNESS_MINIMUMS,
    simulator: Object.freeze({
      enabled: readBoolean(
        env['VL_SIMULATOR_ENABLED'] ?? simulator['enabled'],
        'simulator.enabled',
      ),
    }),
  })
}

/**
 * Overlays the configured values on the content defaults.
 *
 * Structural, not `Object.assign`: an operator may override one number without
 * restating the block around it. A leaf may only be replaced by a value of the
 * same shape as the default, and an unknown key is an error rather than a
 * silently ignored typo — a mistyped tuning key that quietly did nothing is
 * exactly the kind of "값을 임의로 채운" failure spec §11 warns about.
 */
function mergeTuning(base: unknown, override: unknown, path: string): unknown {
  if (override === undefined) return base
  if (!isPlainObject(base)) {
    throw new EngineConfigError(`${path} is not an overridable object`)
  }
  const source = readObject(override, path)
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(source)) {
    if (!(key in base)) {
      throw new EngineConfigError(`${path}.${key} is not a known tuning key`)
    }
    const defaultValue = (base as Record<string, unknown>)[key]
    if (isPlainObject(defaultValue)) {
      merged[key] = mergeTuning(defaultValue, value, `${path}.${key}`)
      continue
    }
    if (Array.isArray(defaultValue)) {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'number')) {
        throw new EngineConfigError(`${path}.${key} must be an array of numbers`)
      }
      merged[key] = [...(value as number[])]
      continue
    }
    if (typeof value !== typeof defaultValue) {
      throw new EngineConfigError(`${path}.${key} must be a ${typeof defaultValue}`)
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new EngineConfigError(`${path}.${key} must be a finite number`)
    }
    merged[key] = value
  }
  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new EngineConfigError(`${path} must be an object`)
  }
  return value
}

function readInt(value: unknown, path: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new EngineConfigError(`${path} must be an integer`)
  }
  return parsed
}

function readPositiveInt(value: unknown, path: string): number {
  const parsed = readInt(value, path)
  if (parsed <= 0) throw new EngineConfigError(`${path} must be greater than 0`)
  return parsed
}

function readNonNegativeInt(value: unknown, path: string): number {
  const parsed = readInt(value, path)
  if (parsed < 0) throw new EngineConfigError(`${path} must not be negative`)
  return parsed
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new EngineConfigError(`${path} must be a non-empty string`)
  }
  return value
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new EngineConfigError(`${path} must be a boolean`)
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new EngineConfigError(`${path} must be an array of strings`)
  }
  return [...(value as string[])]
}
