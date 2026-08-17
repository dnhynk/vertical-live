import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type Database from 'better-sqlite3'

import type { Clock } from '../clock.js'
import { PersistenceInvariantError } from './errors.js'

/**
 * Migration runner over numbered SQL files (`docs/tasks/TASK_SPECS.md` §T4).
 *
 * Each file is applied in its own transaction and recorded with a checksum. An
 * already-applied file whose bytes changed is a hard failure: the schema on disk
 * would no longer be the schema the file describes, and this store is the
 * authority for paid audit rows (spec §10.2), so silently continuing is worse
 * than refusing to start.
 */

/** `src/db/migrations` in a source run, `dist/db/migrations` in a built run. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url))

const MIGRATION_FILE_PATTERN = /^(\d{3})_([a-z0-9-]+)\.sql$/

export interface Migration {
  readonly version: number
  readonly name: string
  readonly fileName: string
  readonly sql: string
  readonly checksum: string
}

export interface AppliedMigration {
  readonly version: number
  readonly name: string
  readonly checksum: string
  readonly appliedAt: string
}

export class MigrationError extends PersistenceInvariantError {
  constructor(message: string) {
    super(`migration failed: ${message}`)
    this.name = 'MigrationError'
  }
}

export function loadMigrations(directory: string = MIGRATIONS_DIR): Migration[] {
  const fileNames = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const migrations = fileNames.map((fileName) => {
    const match = MIGRATION_FILE_PATTERN.exec(fileName)
    if (match === null) {
      throw new MigrationError(`${fileName} must be named NNN_lower-kebab-name.sql`)
    }
    const [, version, name] = match as unknown as [string, string, string]
    const sql = readFileSync(join(directory, fileName), 'utf8')
    return {
      version: Number(version),
      name,
      fileName,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    }
  })

  migrations.forEach((migration, index) => {
    // Gaps are allowed (a reverted branch may burn a number); duplicates and a
    // non-1-based start are not, because the version is the primary key.
    if (migration.version < 1) {
      throw new MigrationError(`${migration.fileName} must have a version >= 1`)
    }
    const previous = migrations[index - 1]
    if (previous !== undefined && previous.version === migration.version) {
      throw new MigrationError(
        `duplicate version ${String(migration.version)}: ${previous.fileName}, ${migration.fileName}`,
      )
    }
  })

  return migrations
}

export interface MigrateOptions {
  readonly directory?: string
  readonly clock: Clock
}

export interface MigrateResult {
  readonly applied: readonly Migration[]
  readonly alreadyApplied: readonly AppliedMigration[]
}

export function migrate(database: Database.Database, options: MigrateOptions): MigrateResult {
  // The bookkeeping table cannot itself live in a migration file: the runner
  // needs it before it can decide what to apply.
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY CHECK (version >= 1),
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  ) STRICT`)

  const alreadyApplied = listAppliedMigrations(database)
  const appliedByVersion = new Map(alreadyApplied.map((row) => [row.version, row]))
  const migrations = loadMigrations(options.directory)
  const applied: Migration[] = []

  const record = database.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  )

  for (const migration of migrations) {
    const previous = appliedByVersion.get(migration.version)
    if (previous !== undefined) {
      if (previous.checksum !== migration.checksum) {
        throw new MigrationError(
          `${migration.fileName} changed after it was applied (recorded ${previous.checksum.slice(0, 12)}, file ${migration.checksum.slice(0, 12)}); add a new migration instead of editing an applied one`,
        )
      }
      continue
    }

    // One transaction per file. `exec` runs every statement in the file, so a
    // failure half way through leaves no partially created schema.
    const apply = database.transaction(() => {
      database.exec(migration.sql)
      record.run(migration.version, migration.name, migration.checksum, options.clock.nowUtcIso())
    })
    try {
      apply()
    } catch (error) {
      throw new MigrationError(`${migration.fileName}: ${(error as Error).message}`)
    }
    applied.push(migration)
  }

  return { applied, alreadyApplied }
}

export function listAppliedMigrations(database: Database.Database): AppliedMigration[] {
  const rows = database
    .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string; checksum: string; applied_at: string }[]
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }))
}
