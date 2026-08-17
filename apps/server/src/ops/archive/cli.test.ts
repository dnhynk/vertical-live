import { describe, expect, it } from 'vitest'

import { FakeClock } from '../../testing/fake-clock.js'
import type { ArchiveConfig } from './config.js'
import { runArchiveCli } from './cli.js'
import type { ArchiveDirEntry, ArchiveFsPort } from './sweep.js'

/** The operator entry point. Its one safety property: deleting is opt-in. */

const NOW_MS = Date.UTC(2026, 7, 17, 12, 0, 0)
const DAY_MS = 86_400_000
const MB = 1_048_576

const config: ArchiveConfig = {
  enabled: true,
  retentionDays: 7,
  maxTotalBytes: 100 * MB,
  minFreeBytes: 50 * MB,
  activeFileGraceMs: 600_000,
  roots: [{ name: 'recordings', path: '/archive/recordings', extensions: ['.mkv'] }],
  provisional: ['retentionDays'],
}

const clock = new FakeClock({ epochMs: NOW_MS })

function fs(entries: readonly ArchiveDirEntry[]): ArchiveFsPort & { readonly removed: string[] } {
  const removed: string[] = []
  return {
    removed,
    exists: () => true,
    list: () => entries,
    remove: (path) => {
      removed.push(path)
    },
    freeBytes: () => 500 * MB,
  }
}

const old: ArchiveDirEntry = {
  path: '/archive/recordings/old.mkv',
  sizeBytes: 2 * MB,
  modifiedMs: NOW_MS - 30 * DAY_MS,
}

function run(argv: readonly string[], port: ArchiveFsPort) {
  const lines: string[] = []
  const code = runArchiveCli(argv, {
    io: { write: (line) => lines.push(line) },
    config,
    fs: port,
    clock,
  })
  return { code, out: lines.join('\n') }
}

describe('runArchiveCli', () => {
  it('deletes nothing without --apply and says so', () => {
    const port = fs([old])

    const { code, out } = run([], port)

    expect(code).toBe(0)
    expect(port.removed).toEqual([])
    expect(out).toContain('dry run — nothing deleted')
    expect(out).toContain('would delete 1 file(s)')
    expect(out).toContain('[retention_days]')
  })

  it('deletes with --apply', () => {
    const port = fs([old])

    const { code, out } = run(['--apply'], port)

    expect(code).toBe(0)
    expect(port.removed).toEqual(['/archive/recordings/old.mkv'])
    expect(out).toContain('APPLY')
    expect(out).toContain('deleted 1 file(s)')
  })

  it('treats --dry-run as the explicit form of the default', () => {
    const port = fs([old])

    expect(run(['--apply', '--dry-run'], port).code).toBe(0)
    expect(port.removed).toEqual([])
  })

  it('emits a machine-readable report with --json', () => {
    const { out } = run(['--json'], fs([old]))

    const parsed = JSON.parse(out) as { applied: boolean; plan: { deletions: unknown[] } }
    expect(parsed.applied).toBe(false)
    expect(parsed.plan.deletions).toHaveLength(1)
  })

  it('says the rules are provisional so nobody reads them as a pass line', () => {
    expect(run([], fs([])).out).toContain('provisional, BOARD A-15')
  })

  it('reports an unmet rule as a warning, not as a failure exit code', () => {
    const huge: ArchiveDirEntry = {
      path: '/archive/recordings/live.mkv',
      sizeBytes: 400 * MB,
      modifiedMs: NOW_MS - 1_000,
    }

    const { code, out } = run(['--apply'], fs([huge]))

    expect(code).toBe(0)
    expect(out).toContain('WARNING: max_total_bytes is still unmet')
  })

  it('exits non-zero when a delete fails', () => {
    const port = fs([old])
    const failing: ArchiveFsPort = {
      ...port,
      remove: () => {
        throw new Error('EPERM')
      },
    }
    const lines: string[] = []

    const code = runArchiveCli(['--apply'], {
      io: { write: (line) => lines.push(line) },
      config,
      fs: failing,
      clock,
    })

    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('FAILED /archive/recordings/old.mkv: EPERM')
  })

  it('scans nothing when the archive is disabled', () => {
    const port = fs([old])
    const lines: string[] = []

    const code = runArchiveCli(['--apply'], {
      io: { write: (line) => lines.push(line) },
      config: { ...config, enabled: false },
      fs: port,
      clock,
    })

    expect(code).toBe(0)
    expect(port.removed).toEqual([])
    expect(lines.join('\n')).toContain('archive.enabled is false')
  })

  it('refuses an unknown argument instead of guessing', () => {
    const lines: string[] = []

    const code = runArchiveCli(['--force'], { io: { write: (line) => lines.push(line) }, config })

    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('unknown argument: --force')
  })

  it('prints usage for --help', () => {
    const lines: string[] = []

    expect(runArchiveCli(['--help'], { io: { write: (line) => lines.push(line) } })).toBe(0)
    expect(lines.join('\n')).toContain('DRY RUN')
  })

  it('reports a config file it cannot read', () => {
    const lines: string[] = []

    const code = runArchiveCli(['--config', '/does/not/exist.json'], {
      io: { write: (line) => lines.push(line) },
    })

    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('cannot read')
  })
})
