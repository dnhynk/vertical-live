import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DB_BUSY_TIMEOUT_ENV,
  DB_FILE_ENV,
  DatabaseConfigError,
  loadDatabaseConfig,
} from './config.js'

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true })
  }
})

function writeConfig(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'vl-config-'))
  directories.push(directory)
  const path = join(directory, 'default.json')
  writeFileSync(path, JSON.stringify(contents), 'utf8')
  return path
}

describe('loadDatabaseConfig', () => {
  it('reads the repository config with no env overrides', () => {
    const config = loadDatabaseConfig({ env: {} })
    // BOARD A-14 / TASK_SPECS 공통 규약 fix the file name.
    expect(config.file.replaceAll('\\', '/')).toMatch(/\/data\/vertical-live\.db$/)
    expect(isAbsolute(config.file)).toBe(true)
    expect(config.busyTimeoutMs).toBeGreaterThan(0)
    // The value is not fixed by the spec, so it must stay labelled (BOARD A-15).
    expect(config.provisional).toContain('busyTimeoutMs')
  })

  it('resolves a relative file against the config directory', () => {
    const path = writeConfig({
      db: { file: 'data/test.db', busyTimeoutMs: 100, provisional: [] },
    })
    const config = loadDatabaseConfig({ configPath: path, env: {} })
    expect(config.file).toBe(join(path, '..', 'data', 'test.db'))
  })

  it('lets the environment override the file and the timeout', () => {
    const path = writeConfig({
      db: { file: 'data/test.db', busyTimeoutMs: 100, provisional: [] },
    })
    const config = loadDatabaseConfig({
      configPath: path,
      env: { [DB_FILE_ENV]: join(tmpdir(), 'override.db'), [DB_BUSY_TIMEOUT_ENV]: '7500' },
    })
    expect(config.file).toBe(join(tmpdir(), 'override.db'))
    expect(config.busyTimeoutMs).toBe(7500)
  })

  it('rejects a missing section, a bad timeout and an unreadable file', () => {
    expect(() => loadDatabaseConfig({ configPath: writeConfig({}), env: {} })).toThrow(
      DatabaseConfigError,
    )
    expect(() =>
      loadDatabaseConfig({
        configPath: writeConfig({ db: { file: 'x.db', busyTimeoutMs: 0, provisional: [] } }),
        env: {},
      }),
    ).toThrow(DatabaseConfigError)
    expect(() =>
      loadDatabaseConfig({
        configPath: writeConfig({ db: { file: 'x.db', busyTimeoutMs: 100, provisional: [] } }),
        env: { [DB_BUSY_TIMEOUT_ENV]: 'soon' },
      }),
    ).toThrow(DatabaseConfigError)
    expect(() =>
      loadDatabaseConfig({ configPath: join(tmpdir(), 'vl-missing-config.json'), env: {} }),
    ).toThrow(DatabaseConfigError)
  })
})
