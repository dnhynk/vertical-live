import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Persistence settings. Non-secret values live in `config/default.json` (`db`)
 * with env overrides, matching the shared convention in
 * `docs/tasks/TASK_SPECS.md` 공통 규약. The database file itself holds no secret
 * (spec §10.2: refresh tokens, stream keys and passwords live in the OS vault).
 *
 * `busyTimeoutMs` is listed in `provisional` (BOARD A-15): no spec section and no
 * sqlite.org page fixes a value, so it is replaced by the Gate 2 fault-matrix
 * measurement and is not treated as a pass/fail line.
 */

export interface DatabaseConfig {
  /** Absolute path of the SQLite file. WAL needs a real file, not `:memory:`. */
  readonly file: string
  /** How long a statement waits for a write lock before `SQLITE_BUSY`. */
  readonly busyTimeoutMs: number
  readonly provisional: readonly string[]
}

/** `config/default.json` at the repository root, from `src/…` or `dist/…`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/default.json', import.meta.url),
)

export const DB_FILE_ENV = 'VL_DB_FILE'
export const DB_BUSY_TIMEOUT_ENV = 'VL_DB_BUSY_TIMEOUT_MS'

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(`invalid db config: ${message}`)
    this.name = 'DatabaseConfigError'
  }
}

export interface LoadDatabaseConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadDatabaseConfig(options: LoadDatabaseConfigOptions = {}): DatabaseConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env
  const section = readDbSection(configPath)

  const file = readEnvString(env, DB_FILE_ENV) ?? readString(section['file'], 'db.file')
  const busyTimeoutRaw = readEnvString(env, DB_BUSY_TIMEOUT_ENV)
  const busyTimeoutMs =
    busyTimeoutRaw === undefined
      ? readPositiveInt(section['busyTimeoutMs'], 'db.busyTimeoutMs')
      : parsePositiveInt(busyTimeoutRaw, DB_BUSY_TIMEOUT_ENV)

  return Object.freeze({
    // A relative path is relative to the repository root, i.e. to the directory
    // holding the config file, so the server resolves the same file whether it
    // is started from the repository root or from `apps/server`.
    file: isAbsolute(file) ? file : resolve(dirname(configPath), file),
    busyTimeoutMs,
    provisional: Object.freeze(readStringArray(section['provisional'], 'db.provisional')),
  })
}

function readDbSection(configPath: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new DatabaseConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }
  return asObject(asObject(parsed, 'root')['db'], 'db')
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DatabaseConfigError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new DatabaseConfigError(`${label} must be a non-empty string`)
  }
  return value
}

function readPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DatabaseConfigError(`${label} must be a positive integer`)
  }
  return value
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new DatabaseConfigError(`${label} must be an array of strings`)
  }
  return value as string[]
}

function readEnvString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]
  return raw === undefined || raw === '' ? undefined : raw
}

function parsePositiveInt(raw: string, name: string): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DatabaseConfigError(`${name} must be a positive integer, got ${raw}`)
  }
  return parsed
}
