import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FakeClock } from '../../testing/fake-clock.js'
import { loadArchiveConfig, type ArchiveConfig } from './config.js'
import {
  hasExtension,
  isInside,
  nodeArchiveFs,
  resolveRoot,
  runArchiveSweep,
  type ArchiveDirEntry,
  type ArchiveFsPort,
} from './sweep.js'

/**
 * The sweep runner: scanning, path handling and the dry-run default. Deleting
 * files is the one thing here that must never happen by accident, so the mode
 * that deletes is opt-in and a test pins it (TASK_SPECS §T17 합격 기준 1).
 */

const NOW_MS = Date.UTC(2026, 7, 17, 12, 0, 0)
const DAY_MS = 86_400_000
const MB = 1_048_576

const config: ArchiveConfig = {
  enabled: true,
  retentionDays: 7,
  maxTotalBytes: 100 * MB,
  minFreeBytes: 50 * MB,
  activeFileGraceMs: 600_000,
  roots: [
    { name: 'recordings', path: '/archive/recordings', extensions: ['.mkv'] },
    { name: 'diagnostics', path: '/archive/shots', extensions: ['.jpg'] },
  ],
  provisional: [],
}

const clock = new FakeClock({ epochMs: NOW_MS })

interface FakeFs extends ArchiveFsPort {
  readonly removed: string[]
}

/**
 * Keys are resolved the same way the sweeper resolves roots, so the fake
 * behaves on Windows (BOARD D-2) as it does on a POSIX host: `/archive/...`
 * resolves to `C:\archive\...` there.
 */
function fakeFs(
  contents: Record<string, readonly ArchiveDirEntry[]>,
  freeBytes: Record<string, number> = {},
): FakeFs {
  const removed: string[] = []
  const listings = new Map(
    Object.entries(contents).map(([path, entries]) => [resolve(path), entries]),
  )
  const free = new Map(Object.entries(freeBytes).map(([path, bytes]) => [resolve(path), bytes]))
  return {
    removed,
    exists: (path) => listings.has(resolve(path)),
    list: (path) => listings.get(resolve(path)) ?? [],
    remove: (path) => {
      removed.push(path)
    },
    freeBytes: (path) => free.get(resolve(path)) ?? 500 * MB,
  }
}

function entry(path: string, ageDays: number, sizeMb: number): ArchiveDirEntry {
  return { path, sizeBytes: sizeMb * MB, modifiedMs: NOW_MS - ageDays * DAY_MS }
}

describe('runArchiveSweep', () => {
  it('is a dry run unless apply is asked for', () => {
    const fs = fakeFs({
      '/archive/recordings': [entry('/archive/recordings/old.mkv', 30, 1)],
      '/archive/shots': [],
    })

    const result = runArchiveSweep({ config, fs, clock })

    expect(result.applied).toBe(false)
    expect(result.plan.deletions).toHaveLength(1)
    expect(result.deleted).toEqual([])
    expect(fs.removed).toEqual([])
  })

  it('deletes exactly the planned files when applied', () => {
    const fs = fakeFs({
      '/archive/recordings': [
        entry('/archive/recordings/old.mkv', 30, 1),
        entry('/archive/recordings/new.mkv', 1, 1),
      ],
      '/archive/shots': [],
    })

    const result = runArchiveSweep({ config, fs, clock, apply: true })

    expect(result.applied).toBe(true)
    expect(fs.removed).toEqual(['/archive/recordings/old.mkv'])
    expect(result.deleted).toEqual(['/archive/recordings/old.mkv'])
    expect(result.failed).toEqual([])
  })

  it('reports a delete that failed instead of counting it as reclaimed space', () => {
    const fs = fakeFs({
      '/archive/recordings': [entry('/archive/recordings/locked.mkv', 30, 1)],
      '/archive/shots': [],
    })
    const failing: ArchiveFsPort = {
      ...fs,
      remove: () => {
        throw new Error('EBUSY: resource busy or locked')
      },
    }

    const result = runArchiveSweep({ config, fs: failing, clock, apply: true })

    expect(result.deleted).toEqual([])
    expect(result.failed).toEqual([
      { path: '/archive/recordings/locked.mkv', error: 'EBUSY: resource busy or locked' },
    ])
  })

  it('treats a root that does not exist yet as empty, not as a failure', () => {
    // V1 does not record (`RecEncoder=none`), so the recordings directory is
    // absent on a fresh host until an operator turns recording on.
    const fs = fakeFs({ '/archive/shots': [entry('/archive/shots/a.jpg', 1, 1)] })

    const result = runArchiveSweep({ config, fs, clock })

    expect(result.roots[0]).toMatchObject({ name: 'recordings', exists: false, files: 0 })
    expect(result.roots[1]).toMatchObject({ name: 'diagnostics', exists: true, files: 1 })
  })

  it('ignores files whose extension the root does not own', () => {
    const fs = fakeFs({
      '/archive/recordings': [
        entry('/archive/recordings/keep.txt', 30, 1),
        entry('/archive/recordings/sweep.MKV', 30, 1),
      ],
      '/archive/shots': [],
    })

    const result = runArchiveSweep({ config, fs, clock, apply: true })

    expect(fs.removed).toEqual(['/archive/recordings/sweep.MKV'])
  })

  it('drops a listed path that is not inside its root', () => {
    // A symlink or a `..` segment must not turn into a deletion candidate.
    const fs = fakeFs({
      '/archive/recordings': [
        entry('/archive/recordings/inside.mkv', 30, 1),
        entry('/archive/recordings/../../elsewhere/outside.mkv', 30, 1),
      ],
      '/archive/shots': [],
    })

    const result = runArchiveSweep({ config, fs, clock, apply: true })

    expect(fs.removed).toEqual(['/archive/recordings/inside.mkv'])
    expect(result.plan.scannedFiles).toBe(1)
  })

  it('uses the tightest free-space reading across roots', () => {
    const fs = fakeFs(
      {
        '/archive/recordings': [entry('/archive/recordings/a.mkv', 5, 20)],
        '/archive/shots': [],
      },
      { '/archive/recordings': 500 * MB, '/archive/shots': 10 * MB },
    )

    const result = runArchiveSweep({ config, fs, clock })

    expect(result.freeBytes).toBe(10 * MB)
    expect(result.plan.deletions[0]?.reason).toBe('min_free_bytes')
  })

  it('records the sweep instant from the injected clock', () => {
    const fs = fakeFs({ '/archive/recordings': [], '/archive/shots': [] })

    expect(runArchiveSweep({ config, fs, clock }).at).toBe(new Date(NOW_MS).toISOString())
  })
})

describe('archive paths', () => {
  it('resolves relative roots against the working directory', () => {
    const resolved = resolveRoot(
      { name: 'recordings', path: 'data/archive/recordings', extensions: [] },
      join('C:', 'repo'),
    )

    expect(resolved.endsWith(join('repo', 'data', 'archive', 'recordings'))).toBe(true)
  })

  it('keeps an absolute root as given', () => {
    const absolute = join(tmpdir(), 'vl-archive')

    expect(resolveRoot({ name: 'r', path: absolute, extensions: [] }, join('C:', 'repo'))).toBe(
      absolute,
    )
  })

  it('rejects paths outside the root, including the root itself', () => {
    const root = join(tmpdir(), 'vl-root')

    expect(isInside(root, join(root, 'a', 'b.mkv'))).toBe(true)
    expect(isInside(root, root)).toBe(false)
    expect(isInside(root, join(root, '..', 'sibling.mkv'))).toBe(false)
  })

  it('matches extensions case-insensitively and accepts every file when the list is empty', () => {
    expect(hasExtension('/a/B.MKV', ['.mkv'])).toBe(true)
    expect(hasExtension('/a/b.txt', ['.mkv'])).toBe(false)
    expect(hasExtension('/a/b.txt', [])).toBe(true)
  })
})

describe('nodeArchiveFs', () => {
  const root = join(tmpdir(), `vl-archive-test-${String(process.pid)}`)

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists files recursively with their size and mtime, and deletes one', () => {
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'a.mkv'), 'aaaa')
    writeFileSync(join(root, 'nested', 'b.mkv'), 'bb')

    const listed = [...nodeArchiveFs.list(root)].sort((left, right) =>
      left.path.localeCompare(right.path),
    )

    expect(listed).toHaveLength(2)
    expect(listed[0]?.sizeBytes).toBe(4)
    expect(listed[1]?.sizeBytes).toBe(2)
    expect(listed[0]?.modifiedMs).toBeGreaterThan(0)

    nodeArchiveFs.remove(join(root, 'a.mkv'))
    expect(readdirSync(root)).toEqual(['nested'])
    expect(nodeArchiveFs.exists(join(root, 'a.mkv'))).toBe(false)
  })

  it('reads free space for a real directory', () => {
    mkdirSync(root, { recursive: true })

    expect(nodeArchiveFs.freeBytes(root)).toBeGreaterThan(0)
  })
})

describe('shipped archive config', () => {
  it('lists every tunable value as provisional (BOARD A-15)', () => {
    const shipped = loadArchiveConfig()

    expect(shipped.provisional).toEqual(
      expect.arrayContaining([
        'retentionDays',
        'maxTotalBytes',
        'minFreeBytes',
        'activeFileGraceMs',
        'roots',
      ]),
    )
  })
})
