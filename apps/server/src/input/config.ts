import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { InputPerUserConfig, InputWindowConfig } from './arbiter.js'
import type { ParserLimits } from './parse.js'

/**
 * Input settings from `config/default.json` with env overrides (the shared
 * convention in `docs/tasks/TASK_SPECS.md` 공통 규약).
 *
 * `window.*` is **approved** (BOARD D-11, 2026-08-19): direct + non-competitive
 * aggregation with windowMs 5000, maxDirectPerWindow 20, enter/exit 30/10, off
 * the `provisional` list. Gate 2 real traffic may re-tune it. `maxRawLength` has
 * no approved value yet and stays in `provisional` (BOARD A-15), which lists
 * what a reader must not mistake for an approved limit.
 */
export interface InputConfig {
  readonly maxRawLength: number
  readonly window: InputWindowConfig
  /** Per-consented-viewer rules (BOARD D-9, A-9); inert while the gate is closed. */
  readonly perUser: InputPerUserConfig
  readonly provisional: readonly string[]
}

/** `config/default.json` at the repository root, from `src/input/` or `dist/input/`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/default.json', import.meta.url),
)

export class InputConfigError extends Error {
  constructor(message: string) {
    super(`invalid input config: ${message}`)
    this.name = 'InputConfigError'
  }
}

export interface LoadInputConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadInputConfig(options: LoadInputConfigOptions = {}): InputConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new InputConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }

  const input = readObject(parsed, 'root')['input']
  if (input === undefined) {
    throw new InputConfigError(`missing "input" section in ${configPath}`)
  }
  const section = readObject(input, 'input')
  const window = readObject(section['window'], 'input.window')
  const perUser = readObject(section['perUser'], 'input.perUser')

  const config: InputConfig = Object.freeze({
    maxRawLength: readPositiveInt(
      env['VL_INPUT_MAX_RAW_LENGTH'] ?? section['maxRawLength'],
      'input.maxRawLength',
    ),
    window: Object.freeze({
      windowMs: readPositiveInt(
        env['VL_INPUT_WINDOW_MS'] ?? window['windowMs'],
        'input.window.windowMs',
      ),
      enterAggregateAtCommands: readPositiveInt(
        env['VL_INPUT_ENTER_AGGREGATE_AT'] ?? window['enterAggregateAtCommands'],
        'input.window.enterAggregateAtCommands',
      ),
      exitAggregateAtCommands: readNonNegativeInt(
        env['VL_INPUT_EXIT_AGGREGATE_AT'] ?? window['exitAggregateAtCommands'],
        'input.window.exitAggregateAtCommands',
      ),
      maxDirectPerWindow: readNonNegativeInt(
        env['VL_INPUT_MAX_DIRECT_PER_WINDOW'] ?? window['maxDirectPerWindow'],
        'input.window.maxDirectPerWindow',
      ),
    }),
    perUser: Object.freeze({
      cooldownMs: readNonNegativeInt(
        env['VL_INPUT_PER_USER_COOLDOWN_MS'] ?? perUser['cooldownMs'],
        'input.perUser.cooldownMs',
      ),
    }),
    provisional: Object.freeze(readStringArray(section['provisional'], 'input.provisional')),
  })

  if (config.window.exitAggregateAtCommands > config.window.enterAggregateAtCommands) {
    throw new InputConfigError(
      'input.window.exitAggregateAtCommands must not exceed enterAggregateAtCommands',
    )
  }
  return config
}

/** The subset the pure parser needs, so it never reads the file itself. */
export function parserLimits(config: InputConfig): ParserLimits {
  return { maxRawLength: config.maxRawLength }
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputConfigError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function readInt(value: unknown, path: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new InputConfigError(`${path} must be an integer`)
  }
  return parsed
}

function readPositiveInt(value: unknown, path: string): number {
  const parsed = readInt(value, path)
  if (parsed <= 0) {
    throw new InputConfigError(`${path} must be greater than 0`)
  }
  return parsed
}

function readNonNegativeInt(value: unknown, path: string): number {
  const parsed = readInt(value, path)
  if (parsed < 0) {
    throw new InputConfigError(`${path} must not be negative`)
  }
  return parsed
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InputConfigError(`${path} must be an array of strings`)
  }
  return [...(value as string[])]
}
