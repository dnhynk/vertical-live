import { describe, expect, it } from 'vitest'

import { loadArchiveConfig, type ArchiveConfig } from './config.js'
import { planArchiveSweep, type ArchiveFile } from './plan.js'

/**
 * The rolling archive's deletion rules (spec §9.1 "용량 제한이 있는 로컬 rolling
 * archive", §11 "최대 용량·최소 여유공간·보존·자동 삭제 규칙"). Every number the
 * tests use is a fixture, not a pass line: the shipped values are provisional
 * until Gate 2 (BOARD A-15).
 */

const NOW_MS = Date.UTC(2026, 7, 17, 12, 0, 0)
const DAY_MS = 86_400_000
const MB = 1_048_576

const base: ArchiveConfig = {
  enabled: true,
  retentionDays: 7,
  maxTotalBytes: 100 * MB,
  minFreeBytes: 50 * MB,
  activeFileGraceMs: 600_000,
  roots: [{ name: 'recordings', path: 'data/archive/recordings', extensions: ['.mkv'] }],
  provisional: [],
}

function file(name: string, ageDays: number, sizeMb: number): ArchiveFile {
  return {
    root: 'recordings',
    path: `/archive/${name}`,
    sizeBytes: sizeMb * MB,
    modifiedMs: NOW_MS - ageDays * DAY_MS,
  }
}

function plan(config: Partial<ArchiveConfig>, files: readonly ArchiveFile[], freeBytes: number) {
  return planArchiveSweep({ config: { ...base, ...config }, files, freeBytes, nowMs: NOW_MS })
}

describe('planArchiveSweep', () => {
  it('deletes files older than the retention window and nothing else', () => {
    const result = plan({}, [file('old.mkv', 9, 1), file('fresh.mkv', 2, 1)], 500 * MB)

    expect(result.deletions.map((entry) => entry.file.path)).toEqual(['/archive/old.mkv'])
    expect(result.deletions[0]?.reason).toBe('retention_days')
    expect(result.reclaimBytes).toBe(MB)
    expect(result.unmetRules).toEqual([])
  })

  it('deletes oldest first until the archive fits under maxTotalBytes', () => {
    const files = [file('a.mkv', 5, 60), file('b.mkv', 4, 60), file('c.mkv', 3, 60)]

    const result = plan({}, files, 500 * MB)

    // 180MB against a 100MB ceiling: the two oldest go, the newest stays.
    expect(result.deletions.map((entry) => entry.file.path)).toEqual([
      '/archive/a.mkv',
      '/archive/b.mkv',
    ])
    expect(result.deletions.every((entry) => entry.reason === 'max_total_bytes')).toBe(true)
    expect(result.totalBytesAfter).toBe(60 * MB)
    expect(result.unmetRules).toEqual([])
  })

  it('deletes until the volume has minFreeBytes again', () => {
    const files = [file('a.mkv', 5, 20), file('b.mkv', 4, 20), file('c.mkv', 3, 20)]

    const result = plan({}, files, 20 * MB)

    // 20MB free against a 50MB floor: two 20MB files bring it to 60MB.
    expect(result.deletions.map((entry) => entry.file.path)).toEqual([
      '/archive/a.mkv',
      '/archive/b.mkv',
    ])
    expect(result.deletions.every((entry) => entry.reason === 'min_free_bytes')).toBe(true)
    expect(result.freeBytesAfter).toBe(60 * MB)
  })

  it('names the rule that condemned each file when several apply', () => {
    const files = [file('expired.mkv', 30, 10), file('big-a.mkv', 5, 60), file('big-b.mkv', 4, 60)]

    const result = plan({}, files, 500 * MB)

    expect(result.deletions).toEqual([
      { file: files[0], reason: 'retention_days' },
      { file: files[1], reason: 'max_total_bytes' },
    ])
  })

  it('never proposes a file that may still be open for writing', () => {
    // An in-progress OBS recording keeps getting written to, so its mtime is
    // inside the grace window even though the disk is over budget.
    const active: ArchiveFile = {
      root: 'recordings',
      path: '/archive/recording-now.mkv',
      sizeBytes: 400 * MB,
      modifiedMs: NOW_MS - 1_000,
    }

    const result = plan({}, [active], 1 * MB)

    expect(result.deletions).toEqual([])
    expect(result.protectedFiles).toBe(1)
    expect(result.scannedBytes).toBe(400 * MB)
    // It still counts against the budget, and the report says the rules do not
    // hold rather than reporting a clean sweep.
    expect(result.unmetRules).toEqual(['max_total_bytes', 'min_free_bytes'])
  })

  it('reports rules it cannot satisfy instead of claiming success', () => {
    // Everything eligible is deleted and the volume is still short: the disk is
    // full of something the archive does not own.
    const result = plan({}, [file('a.mkv', 5, 1)], 1 * MB)

    expect(result.deletions).toHaveLength(1)
    expect(result.unmetRules).toEqual(['min_free_bytes'])
    expect(result.freeBytesAfter).toBe(2 * MB)
  })

  it('orders equal timestamps by path so a dry run matches the sweep after it', () => {
    const sameMs = NOW_MS - 5 * DAY_MS
    const files: ArchiveFile[] = ['c.mkv', 'a.mkv', 'b.mkv'].map((name) => ({
      root: 'recordings',
      path: `/archive/${name}`,
      sizeBytes: 60 * MB,
      modifiedMs: sameMs,
    }))

    const first = plan({}, files, 500 * MB)
    const second = plan({}, [...files].reverse(), 500 * MB)

    expect(first.deletions.map((entry) => entry.file.path)).toEqual([
      '/archive/a.mkv',
      '/archive/b.mkv',
    ])
    expect(second.deletions).toEqual(first.deletions)
  })

  it('plans nothing when the archive is empty', () => {
    const result = plan({}, [], 500 * MB)

    expect(result).toMatchObject({
      scannedFiles: 0,
      scannedBytes: 0,
      deletions: [],
      reclaimBytes: 0,
      unmetRules: [],
    })
  })

  it('uses the shipped provisional configuration without modification', () => {
    const shipped = loadArchiveConfig()

    const result = planArchiveSweep({
      config: shipped,
      files: [
        {
          root: 'recordings',
          path: '/archive/ancient.mkv',
          sizeBytes: MB,
          modifiedMs: NOW_MS - (shipped.retentionDays + 1) * DAY_MS,
        },
      ],
      freeBytes: shipped.minFreeBytes,
      nowMs: NOW_MS,
    })

    expect(result.deletions[0]?.reason).toBe('retention_days')
  })
})
