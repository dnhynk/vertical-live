import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Local rolling-archive settings from `config/default.json` with env overrides
 * (TASK_SPECS 공통 규약).
 *
 * Spec §9.1 makes the product responsible for "용량 제한이 있는 로컬 rolling
 * archive"; spec §11 says the rules themselves — "rolling archive의 최대 용량·
 * 최소 여유공간·보존·자동 삭제 규칙" — are approved at the same point as the
 * other reliability numbers, before the 72-hour soak. So every value here is
 * **provisional** (BOARD A-15): it exists to give the sweeper something to
 * compare against, and it is not a pass line.
 */

export interface ArchiveRootConfig {
  /** Stable label used in logs and in the sweep report. */
  readonly name: string
  /** Directory to sweep. The CLI resolves relative paths from the repository root. */
  readonly path: string
  /**
   * Lower-case file extensions (with the dot) this root owns. An empty list
   * means every file under the root. Anything else in the directory is left
   * alone: the sweeper deletes what it was pointed at, not what it finds.
   */
  readonly extensions: readonly string[]
}

export interface ArchiveConfig {
  readonly enabled: boolean
  /** Files older than this are deleted even when there is plenty of room. */
  readonly retentionDays: number
  /** Ceiling for the archive's own footprint across all roots. */
  readonly maxTotalBytes: number
  /** Free space the volume must keep; the sweeper deletes until it is met. */
  readonly minFreeBytes: number
  /**
   * A file modified within this window may still be open for writing (an
   * in-progress OBS recording is the case this exists for), so it is never a
   * deletion candidate.
   */
  readonly activeFileGraceMs: number
  readonly roots: readonly ArchiveRootConfig[]
  /** Keys whose values are provisional (BOARD A-15). */
  readonly provisional: readonly string[]
}

/** `config/default.json` at the repository root, from `src/ops/archive/` or `dist/ops/archive/`. */
export const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../../config/default.json', import.meta.url),
)

/** Repository owning the default config, independent of the caller's cwd. */
export const DEFAULT_ARCHIVE_CWD = resolve(dirname(DEFAULT_CONFIG_PATH), '..')

export class ArchiveConfigError extends Error {
  constructor(message: string) {
    super(`invalid archive config: ${message}`)
    this.name = 'ArchiveConfigError'
  }
}

export interface LoadArchiveConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadArchiveConfig(options: LoadArchiveConfigOptions = {}): ArchiveConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new ArchiveConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }

  const root = readObject(parsed, 'root')
  const section = readObject(root['archive'], 'archive')

  return Object.freeze({
    enabled: readBoolean(env['VL_ARCHIVE_ENABLED'] ?? section['enabled'], 'archive.enabled'),
    retentionDays: readPositiveInt(
      env['VL_ARCHIVE_RETENTION_DAYS'] ?? section['retentionDays'],
      'archive.retentionDays',
    ),
    maxTotalBytes: readPositiveInt(
      env['VL_ARCHIVE_MAX_TOTAL_BYTES'] ?? section['maxTotalBytes'],
      'archive.maxTotalBytes',
    ),
    minFreeBytes: readPositiveInt(
      env['VL_ARCHIVE_MIN_FREE_BYTES'] ?? section['minFreeBytes'],
      'archive.minFreeBytes',
    ),
    activeFileGraceMs: readNonNegativeInt(
      section['activeFileGraceMs'],
      'archive.activeFileGraceMs',
    ),
    roots: Object.freeze(readRoots(section['roots'], 'archive.roots')),
    provisional: Object.freeze(readStringArray(section['provisional'], 'archive.provisional')),
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ArchiveConfigError(`${path} must be an object`)
  }
  return value
}

function readInt(value: unknown, path: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new ArchiveConfigError(`${path} must be an integer`)
  }
  return parsed
}

function readPositiveInt(value: unknown, path: string): number {
  const parsed = readInt(value, path)
  if (parsed <= 0) throw new ArchiveConfigError(`${path} must be greater than 0`)
  return parsed
}

function readNonNegativeInt(value: unknown, path: string): number {
  const parsed = readInt(value, path)
  if (parsed < 0) throw new ArchiveConfigError(`${path} must not be negative`)
  return parsed
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ArchiveConfigError(`${path} must be a non-empty string`)
  }
  return value
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ArchiveConfigError(`${path} must be a boolean`)
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ArchiveConfigError(`${path} must be an array of strings`)
  }
  return [...(value as string[])]
}

/**
 * Roots are the *only* directories the sweeper may delete from, so a malformed
 * entry is an error rather than a skipped root: a sweep that silently forgot a
 * root would let the disk fill while reporting success.
 */
function readRoots(value: unknown, path: string): ArchiveRootConfig[] {
  if (!Array.isArray(value)) {
    throw new ArchiveConfigError(`${path} must be an array`)
  }
  const names = new Set<string>()
  return value.map((entry, index) => {
    const object = readObject(entry, `${path}[${String(index)}]`)
    const name = readNonEmptyString(object['name'], `${path}[${String(index)}].name`)
    if (names.has(name)) {
      throw new ArchiveConfigError(`${path} has duplicate root name ${JSON.stringify(name)}`)
    }
    names.add(name)
    const extensions = readStringArray(
      object['extensions'],
      `${path}[${String(index)}].extensions`,
    ).map((extension) => {
      if (!extension.startsWith('.')) {
        throw new ArchiveConfigError(
          `${path}[${String(index)}].extensions entries must start with "." (got ${JSON.stringify(extension)})`,
        )
      }
      return extension.toLowerCase()
    })
    return Object.freeze({
      name,
      path: readNonEmptyString(object['path'], `${path}[${String(index)}].path`),
      extensions: Object.freeze(extensions),
    })
  })
}
