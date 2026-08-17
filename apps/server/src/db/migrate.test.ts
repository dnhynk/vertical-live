import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import { MigrationError, listAppliedMigrations, loadMigrations, migrate } from './migrate.js'
import { DatabaseOpenError, openDatabase, readPragma } from './open.js'

const BUSY_TIMEOUT_MS = 250

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'vl-migrate-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true })
  }
})

describe('openDatabase', () => {
  it('applies and verifies the durability PRAGMAs', () => {
    const file = join(tempDir(), 'db.sqlite')
    const database = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      expect(readPragma(database, 'journal_mode')).toBe('wal')
      // 2 = FULL. WAL with synchronous=NORMAL "might roll back following a power
      // loss or system crash" — https://sqlite.org/pragma.html#pragma_synchronous
      expect(readPragma(database, 'synchronous')).toBe(2)
      expect(readPragma(database, 'foreign_keys')).toBe(1)
      expect(readPragma(database, 'busy_timeout')).toBe(BUSY_TIMEOUT_MS)
    } finally {
      database.close()
    }
  })

  it('keeps WAL mode after a reopen, as sqlite.org documents', () => {
    const file = join(tempDir(), 'db.sqlite')
    const first = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    first.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY) STRICT')
    first.close()

    const second = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      expect(readPragma(second, 'journal_mode')).toBe('wal')
    } finally {
      second.close()
    }
  })

  it('rejects an in-memory database because WAL needs a file', () => {
    expect(() => openDatabase({ file: ':memory:', busyTimeoutMs: BUSY_TIMEOUT_MS })).toThrow(
      DatabaseOpenError,
    )
  })

  it('rejects a non-positive busy timeout', () => {
    const file = join(tempDir(), 'db.sqlite')
    expect(() => openDatabase({ file, busyTimeoutMs: 0 })).toThrow(DatabaseOpenError)
  })
})

describe('loadMigrations', () => {
  it('reads the numbered files in order with a checksum each', () => {
    const migrations = loadMigrations()
    expect(migrations.length).toBeGreaterThan(0)
    expect(migrations[0]?.version).toBe(1)
    expect(migrations[0]?.name).toBe('initial')
    expect(migrations.map((migration) => migration.version)).toEqual(
      [...migrations].map((migration) => migration.version).sort((a, b) => a - b),
    )
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('rejects a file that is not NNN_name.sql', () => {
    const directory = tempDir()
    writeFileSync(join(directory, 'initial.sql'), 'SELECT 1;')
    expect(() => loadMigrations(directory)).toThrow(MigrationError)
  })

  it('rejects two files claiming the same version', () => {
    const directory = tempDir()
    writeFileSync(join(directory, '001_a.sql'), 'SELECT 1;')
    writeFileSync(join(directory, '001_b.sql'), 'SELECT 1;')
    expect(() => loadMigrations(directory)).toThrow(MigrationError)
  })
})

describe('migrate', () => {
  it('creates every table the persistence layer owns', () => {
    const file = join(tempDir(), 'db.sqlite')
    const database = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      const result = migrate(database, { clock: new FakeClock() })
      // Derived from the directory: every task adds a migration, and pinning the
      // list here would make this test a merge conflict rather than a check.
      expect(result.applied.map((migration) => migration.fileName)).toEqual(
        loadMigrations().map((migration) => migration.fileName),
      )

      const tables = (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name)
      expect(tables).toEqual(
        expect.arrayContaining([
          'broadcast_resources',
          'deadlines',
          'effect_outbox',
          'gift_combo',
          'ingest_inbox',
          'paid_ledger',
          'retention_ledger',
          'schema_migrations',
          'source_checkpoint',
          'state_transitions',
          'world_snapshot',
        ]),
      )
    } finally {
      database.close()
    }
  })

  it('is idempotent: a second run applies nothing', () => {
    const file = join(tempDir(), 'db.sqlite')
    const database = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      const versions = loadMigrations().map((migration) => migration.version)
      migrate(database, { clock: new FakeClock() })
      const second = migrate(database, { clock: new FakeClock() })
      expect(second.applied).toEqual([])
      expect(second.alreadyApplied.map((row) => row.version)).toEqual(versions)
      expect(listAppliedMigrations(database)).toHaveLength(versions.length)
    } finally {
      database.close()
    }
  })

  it('refuses to continue when an applied migration file was edited', () => {
    const directory = tempDir()
    const file = join(tempDir(), 'db.sqlite')
    writeFileSync(join(directory, '001_probe.sql'), 'CREATE TABLE probe (id INTEGER PRIMARY KEY);')
    const database = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      migrate(database, { clock: new FakeClock(), directory })
      writeFileSync(
        join(directory, '001_probe.sql'),
        'CREATE TABLE probe (id INTEGER PRIMARY KEY, extra TEXT);',
      )
      expect(() => migrate(database, { clock: new FakeClock(), directory })).toThrow(
        /changed after it was applied/,
      )
    } finally {
      database.close()
    }
  })

  it('refuses to continue when an applied migration file is gone', () => {
    const directory = tempDir()
    const file = join(tempDir(), 'db.sqlite')
    const probe = join(directory, '001_probe.sql')
    writeFileSync(probe, 'CREATE TABLE probe (id INTEGER PRIMARY KEY);')
    const database = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      migrate(database, { clock: new FakeClock(), directory })
      // Deleting the file used to switch the checksum audit off for it silently:
      // the per-file loop simply never visited the missing migration.
      rmSync(probe)
      expect(() => migrate(database, { clock: new FakeClock(), directory })).toThrow(
        /applied migration 1 \(probe\) has no file/,
      )
    } finally {
      database.close()
    }
  })

  it('refuses to continue when an applied migration file was renamed', () => {
    const directory = tempDir()
    const file = join(tempDir(), 'db.sqlite')
    const sql = 'CREATE TABLE probe (id INTEGER PRIMARY KEY);'
    writeFileSync(join(directory, '001_probe.sql'), sql)
    const database = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      migrate(database, { clock: new FakeClock(), directory })
      rmSync(join(directory, '001_probe.sql'))
      writeFileSync(join(directory, '001_probe-renamed.sql'), sql)
      expect(() => migrate(database, { clock: new FakeClock(), directory })).toThrow(
        /recorded as probe but the file is now 001_probe-renamed\.sql/,
      )
    } finally {
      database.close()
    }
  })

  it('leaves no partial schema when a migration file fails half way', () => {
    const directory = tempDir()
    const file = join(tempDir(), 'db.sqlite')
    writeFileSync(
      join(directory, '001_broken.sql'),
      'CREATE TABLE good (id INTEGER PRIMARY KEY);\nCREATE TABLE bad (id INTEGER PRIMARY KEY;\n',
    )
    const database = openDatabase({ file, busyTimeoutMs: BUSY_TIMEOUT_MS })
    try {
      expect(() => migrate(database, { clock: new FakeClock(), directory })).toThrow(MigrationError)
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'good'")
        .all()
      expect(tables).toEqual([])
      expect(listAppliedMigrations(database)).toEqual([])
    } finally {
      database.close()
    }
  })
})
