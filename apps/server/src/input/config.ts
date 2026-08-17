import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { InputWindowConfig } from './arbiter.js'
import type { ParserLimits } from './parse.js'

/**
 * Input settings from `config/default.json` with env overrides (the shared
 * convention in `docs/tasks/TASK_SPECS.md` 공통 규약).
 *
 * Every number here is **provisional** (BOARD A-3, A-15): spec §6.4 fixes the
 * switching threshold and the window length only after real event rates are
 * measured, so these are starting values, not pass/fail lines. `provisional`
 * lists them so a reader cannot mistake them for approved limits.
 */
export interface InputConfig {
  readonly maxRawLength: number
  readonly window: InputWindowConfig
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
