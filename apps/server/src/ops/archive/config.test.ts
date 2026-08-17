import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ArchiveConfigError, loadArchiveConfig } from './config.js'

/**
 * `config/default.json` is the authority (TASK_SPECS 공통 규약). The archive
 * numbers are provisional until Gate 2 (spec §11, BOARD A-15), so these tests
 * pin the shape and the refusals — a bad root definition must fail loudly,
 * because the roots are the only directories the sweeper may delete from.
 */

const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../../config/default.json', import.meta.url),
)

/** The real file with only the `archive` block replaced. */
function configFileWith(archive: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'vl-archive-config-'))
  const path = join(directory, 'config.json')
  const real = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...real, archive }), 'utf8')
  return path
}

const valid = {
  enabled: true,
  retentionDays: 7,
  maxTotalBytes: 1024,
  minFreeBytes: 512,
  activeFileGraceMs: 0,
  roots: [{ name: 'recordings', path: 'data/archive/recordings', extensions: ['.MKV'] }],
  provisional: [],
}

describe('loadArchiveConfig', () => {
  it('loads the repository defaults with at least one root', () => {
    const config = loadArchiveConfig()

    expect(config.roots.length).toBeGreaterThan(0)
    expect(config.retentionDays).toBeGreaterThan(0)
    expect(config.maxTotalBytes).toBeGreaterThan(0)
    expect(config.minFreeBytes).toBeGreaterThan(0)
  })

  it('normalises extensions to lower case', () => {
    const config = loadArchiveConfig({ configPath: configFileWith(valid) })

    expect(config.roots[0]?.extensions).toEqual(['.mkv'])
  })

  it('takes env overrides for the deployment switches', () => {
    const config = loadArchiveConfig({
      env: {
        VL_ARCHIVE_ENABLED: 'false',
        VL_ARCHIVE_RETENTION_DAYS: '3',
        VL_ARCHIVE_MAX_TOTAL_BYTES: '2048',
        VL_ARCHIVE_MIN_FREE_BYTES: '1024',
      },
    })

    expect(config).toMatchObject({
      enabled: false,
      retentionDays: 3,
      maxTotalBytes: 2048,
      minFreeBytes: 1024,
    })
  })

  it('refuses a root without a path', () => {
    const path = configFileWith({ ...valid, roots: [{ name: 'r', extensions: [] }] })

    expect(() => loadArchiveConfig({ configPath: path })).toThrow(ArchiveConfigError)
  })

  it('refuses duplicate root names, which would make the report ambiguous', () => {
    const path = configFileWith({
      ...valid,
      roots: [
        { name: 'r', path: 'a', extensions: [] },
        { name: 'r', path: 'b', extensions: [] },
      ],
    })

    expect(() => loadArchiveConfig({ configPath: path })).toThrow(/duplicate root name/)
  })

  it('refuses an extension without a leading dot', () => {
    const path = configFileWith({
      ...valid,
      roots: [{ name: 'r', path: 'a', extensions: ['mkv'] }],
    })

    expect(() => loadArchiveConfig({ configPath: path })).toThrow(/must start with/)
  })

  it('refuses a zero or negative retention window', () => {
    expect(() =>
      loadArchiveConfig({ configPath: configFileWith({ ...valid, retentionDays: 0 }) }),
    ).toThrow(/greater than 0/)
  })

  it('refuses a missing archive section', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vl-archive-config-'))
    const path = join(directory, 'config.json')
    writeFileSync(path, JSON.stringify({}), 'utf8')

    expect(() => loadArchiveConfig({ configPath: path })).toThrow(/archive must be an object/)
  })

  it('refuses a config file it cannot read', () => {
    expect(() =>
      loadArchiveConfig({ configPath: join(tmpdir(), 'vl-missing-config.json') }),
    ).toThrow(/cannot read/)
  })
})
