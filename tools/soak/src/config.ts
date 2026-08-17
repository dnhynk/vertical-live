import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Soak settings from `config/default.json` (TASK_SPECS 공통 규약, §T15 "합격선
 * 숫자는 Gate 0/2 승인값을 config로 받는다").
 *
 * Two kinds of number live here and they are **not** interchangeable:
 *
 * - the run shape (`accelerated`, `realtime`): how long the harness runs and how
 *   coarsely it steps. Provisional, because spec §11 fixes no execution budget;
 * - `thresholds`: the pass line of spec §11 — maximum continuous outage,
 *   automatic recovery time, renderer freeze allowance, alert delivery time,
 *   end-to-end p95, broadcast and interaction availability. Spec §11 says those
 *   are approved at Gate 0 and locked before the 72-hour soak, so every one of
 *   them is `null` here. `null` means **not locked**: the report prints the
 *   measurement and states that no pass line applies (BOARD A-15). Nothing in
 *   this repository may invent one.
 *
 * The soak still fails on the invariants spec §2/§9.2/§11 state outright — a lost
 * event, an interruption that never recovered, an unexpected `safe_stopped`.
 * Those are in `report.ts`, with the clause each one comes from, and they are not
 * configurable: a threshold nobody approved cannot excuse them.
 */

export type SoakMode = 'accelerated' | 'realtime'

export interface SoakRunShape {
  /** Total scenario time. Virtual in `accelerated`, wall-clock in `realtime`. */
  readonly durationMs: number
  /**
   * Scenario time between two supervisor evaluations.
   *
   * It has an upper bound the harness enforces: §9.4(1)'s coordinator heartbeat
   * degrades when one evaluation is more than `supervisor.coordinatorHeartbeatTimeoutMs`
   * after the previous one, so a slice coarser than that would report a stalled
   * coordinator for the whole run. `runSoak` refuses such a setting rather than
   * producing a green report about a supervisor that never ran.
   */
  readonly sliceMs: number
  /** Scenario time between two synthetic command batches. */
  readonly injectIntervalMs: number
  /** Synthetic free commands per batch. */
  readonly commandsPerInjection: number
  /** Scenario time between two fault injections from the recoverable schedule. */
  readonly faultIntervalMs: number
}

/**
 * Spec §11 pass line. Every field is `number | null`; `null` is "Gate 0/2 has not
 * locked this yet" and is reported, never judged.
 */
export interface SoakThresholds {
  readonly maxContinuousOutageMs: number | null
  readonly maxRecoveryMs: number | null
  readonly maxFreezeEvents: number | null
  readonly maxAlertDeliveryMs: number | null
  readonly endToEndP95Ms: number | null
  readonly minBroadcastAvailability: number | null
  readonly minInteractionAvailability: number | null
}

export interface SoakConfig {
  readonly accelerated: SoakRunShape
  readonly realtime: SoakRunShape
  /** Where `runSoak` writes its report when the CLI is asked to persist one. */
  readonly reportDirectory: string
  readonly thresholds: SoakThresholds
  /** Config keys still awaiting an approved value (BOARD A-15). */
  readonly provisional: readonly string[]
}

/** `config/default.json` at the repository root, from `src/` or `dist/`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../../config/default.json', import.meta.url))

export class SoakConfigError extends Error {
  constructor(message: string) {
    super(`invalid soak config: ${message}`)
    this.name = 'SoakConfigError'
  }
}

export interface LoadSoakConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadSoakConfig(options: LoadSoakConfigOptions = {}): SoakConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new SoakConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }

  const root = readObject(parsed, 'root')
  const section = readObject(root['soak'], 'soak')
  const thresholds = readObject(section['thresholds'], 'soak.thresholds')

  return Object.freeze({
    accelerated: readShape(section['accelerated'], 'soak.accelerated', {
      durationMs: env['VL_SOAK_DURATION_MS'],
      sliceMs: env['VL_SOAK_SLICE_MS'],
    }),
    realtime: readShape(section['realtime'], 'soak.realtime', {}),
    reportDirectory: readString(
      env['VL_SOAK_REPORT_DIR'] ?? section['reportDirectory'],
      'soak.reportDirectory',
    ),
    thresholds: Object.freeze({
      maxContinuousOutageMs: readOptionalPositiveInt(
        thresholds['maxContinuousOutageMs'],
        'soak.thresholds.maxContinuousOutageMs',
      ),
      maxRecoveryMs: readOptionalPositiveInt(
        thresholds['maxRecoveryMs'],
        'soak.thresholds.maxRecoveryMs',
      ),
      maxFreezeEvents: readOptionalNonNegativeInt(
        thresholds['maxFreezeEvents'],
        'soak.thresholds.maxFreezeEvents',
      ),
      maxAlertDeliveryMs: readOptionalPositiveInt(
        thresholds['maxAlertDeliveryMs'],
        'soak.thresholds.maxAlertDeliveryMs',
      ),
      endToEndP95Ms: readOptionalPositiveInt(
        thresholds['endToEndP95Ms'],
        'soak.thresholds.endToEndP95Ms',
      ),
      minBroadcastAvailability: readOptionalRatio(
        thresholds['minBroadcastAvailability'],
        'soak.thresholds.minBroadcastAvailability',
      ),
      minInteractionAvailability: readOptionalRatio(
        thresholds['minInteractionAvailability'],
        'soak.thresholds.minInteractionAvailability',
      ),
    }),
    provisional: Object.freeze(readStringArray(section['provisional'], 'soak.provisional')),
  })
}

interface ShapeOverrides {
  readonly durationMs?: string | undefined
  readonly sliceMs?: string | undefined
}

function readShape(value: unknown, path: string, overrides: ShapeOverrides): SoakRunShape {
  const shape = readObject(value, path)
  return Object.freeze({
    durationMs: readPositiveInt(overrides.durationMs ?? shape['durationMs'], `${path}.durationMs`),
    sliceMs: readPositiveInt(overrides.sliceMs ?? shape['sliceMs'], `${path}.sliceMs`),
    injectIntervalMs: readPositiveInt(shape['injectIntervalMs'], `${path}.injectIntervalMs`),
    commandsPerInjection: readNonNegativeInt(
      shape['commandsPerInjection'],
      `${path}.commandsPerInjection`,
    ),
    faultIntervalMs: readPositiveInt(shape['faultIntervalMs'], `${path}.faultIntervalMs`),
  })
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SoakConfigError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SoakConfigError(`${path} must be a non-empty string`)
  }
  return value
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SoakConfigError(`${path} must be an array of strings`)
  }
  return value as string[]
}

function readInteger(value: unknown, path: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new SoakConfigError(`${path} must be an integer`)
  }
  return parsed
}

function readPositiveInt(value: unknown, path: string): number {
  const parsed = readInteger(value, path)
  if (parsed <= 0) throw new SoakConfigError(`${path} must be greater than zero`)
  return parsed
}

function readNonNegativeInt(value: unknown, path: string): number {
  const parsed = readInteger(value, path)
  if (parsed < 0) throw new SoakConfigError(`${path} must not be negative`)
  return parsed
}

/** `null` is the documented "not locked yet" value, so it is accepted as-is. */
function readOptionalPositiveInt(value: unknown, path: string): number | null {
  return value === null ? null : readPositiveInt(value, path)
}

function readOptionalNonNegativeInt(value: unknown, path: string): number | null {
  return value === null ? null : readNonNegativeInt(value, path)
}

function readOptionalRatio(value: unknown, path: string): number | null {
  if (value === null) return null
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new SoakConfigError(`${path} must be a ratio between 0 and 1`)
  }
  return parsed
}
