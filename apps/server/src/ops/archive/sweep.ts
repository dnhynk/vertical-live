import { existsSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { systemClock, type Clock } from '../../clock.js'
import { silentLogger, type Logger } from '../../secrets/redaction.js'
import type { ArchiveConfig, ArchiveRootConfig } from './config.js'
import { planArchiveSweep, type ArchiveFile, type ArchiveSweepPlan } from './plan.js'

/**
 * Scans the configured archive roots, plans a sweep (`plan.ts`) and — only when
 * asked to — applies it.
 *
 * **Dry-run is the default.** `apply` has to be passed explicitly, and the CLI
 * only sets it for `--apply`, so the mode that deletes files is never the one
 * you get by forgetting a flag (TASK_SPECS §T17 합격 기준 1).
 */

export interface ArchiveDirEntry {
  readonly path: string
  readonly sizeBytes: number
  readonly modifiedMs: number
}

export interface ArchiveFsPort {
  exists(path: string): boolean
  /** Regular files under `rootPath`, recursively. Symlinks are not followed. */
  list(rootPath: string): readonly ArchiveDirEntry[]
  remove(path: string): void
  /** Free bytes on the volume holding `path`. */
  freeBytes(path: string): number
}

export const nodeArchiveFs: ArchiveFsPort = {
  exists: (path) => existsSync(path),
  list: (rootPath) => listFiles(rootPath),
  remove: (path) => {
    rmSync(path, { force: true })
  },
  freeBytes: (path) => {
    const stats = statfsSync(path)
    return Number(stats.bavail) * Number(stats.bsize)
  },
}

export interface ArchiveRootReport {
  readonly name: string
  readonly path: string
  /** A root that does not exist yet is reported, not an error (V1 does not record). */
  readonly exists: boolean
  readonly files: number
  readonly bytes: number
  readonly freeBytes: number | null
}

export interface ArchiveDeleteFailure {
  readonly path: string
  readonly error: string
}

export interface ArchiveSweepResult {
  readonly at: string
  /** False for a dry run: the plan was computed and nothing was deleted. */
  readonly applied: boolean
  readonly roots: readonly ArchiveRootReport[]
  /** `null` when no volume reading was available. */
  readonly freeBytes: number | null
  readonly plan: ArchiveSweepPlan
  readonly deleted: readonly string[]
  readonly failed: readonly ArchiveDeleteFailure[]
}

export interface RunArchiveSweepOptions {
  readonly config: ArchiveConfig
  /** Deletes only when true. Absent or false is a dry run. */
  readonly apply?: boolean
  readonly fs?: ArchiveFsPort
  readonly clock?: Clock
  readonly logger?: Logger
  /** Base for relative root paths. Defaults to the process working directory. */
  readonly cwd?: string
}

export function runArchiveSweep(options: RunArchiveSweepOptions): ArchiveSweepResult {
  const fs = options.fs ?? nodeArchiveFs
  const clock = options.clock ?? systemClock
  const logger = options.logger ?? silentLogger
  const cwd = options.cwd ?? process.cwd()
  const apply = options.apply === true
  const at = clock.nowUtcIso()
  const nowMs = Date.parse(at)

  const roots: ArchiveRootReport[] = []
  const files: ArchiveFile[] = []
  const freeReadings: number[] = []

  for (const root of options.config.roots) {
    const rootPath = resolveRoot(root, cwd)
    if (!fs.exists(rootPath)) {
      roots.push({
        name: root.name,
        path: rootPath,
        exists: false,
        files: 0,
        bytes: 0,
        freeBytes: null,
      })
      continue
    }

    const found = fs
      .list(rootPath)
      .filter(
        (entry) => isInside(rootPath, entry.path) && hasExtension(entry.path, root.extensions),
      )
      .map((entry) => ({
        root: root.name,
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        modifiedMs: entry.modifiedMs,
      }))

    let freeBytes: number | null = null
    try {
      freeBytes = fs.freeBytes(rootPath)
      freeReadings.push(freeBytes)
    } catch (error) {
      logger.warn('archive free space unreadable', {
        root: root.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    files.push(...found)
    roots.push({
      name: root.name,
      path: rootPath,
      exists: true,
      files: found.length,
      bytes: found.reduce((sum, file) => sum + file.sizeBytes, 0),
      freeBytes,
    })
  }

  // The plan's arithmetic ("deleting this file frees this much") only holds on
  // one volume. Roots are expected to share the host's data volume; if the
  // readings disagree the tightest one is used, which errs towards deleting
  // more rather than towards a full disk.
  //
  // With no root on disk yet — the ordinary state before OBS records anything —
  // the working directory's volume is read instead, so the report still says
  // how much room the host has. If even that fails the value stays `null`:
  // unknown, which the plan treats as "do not apply the free-space rule",
  // rather than 0, which would read as a full disk.
  let freeBytes: number | null = freeReadings.length === 0 ? null : Math.min(...freeReadings)
  if (freeBytes === null) {
    try {
      freeBytes = fs.freeBytes(cwd)
    } catch (error) {
      logger.warn('archive free space unreadable', {
        path: cwd,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const plan = planArchiveSweep({ config: options.config, files, freeBytes, nowMs })

  const deleted: string[] = []
  const failed: ArchiveDeleteFailure[] = []
  if (apply) {
    for (const deletion of plan.deletions) {
      try {
        fs.remove(deletion.file.path)
        deleted.push(deletion.file.path)
      } catch (error) {
        failed.push({
          path: deletion.file.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  for (const rule of plan.unmetRules) {
    logger.warn('archive rule still unmet after sweep', { rule, applied: apply })
  }
  logger.info('archive sweep', {
    applied: apply,
    scannedFiles: plan.scannedFiles,
    planned: plan.deletions.length,
    deleted: deleted.length,
    failed: failed.length,
    reclaimBytes: plan.reclaimBytes,
  })

  return { at, applied: apply, roots, freeBytes, plan, deleted, failed }
}

/** Relative root paths resolve against the working directory (repository root). */
export function resolveRoot(root: ArchiveRootConfig, cwd: string): string {
  return isAbsolute(root.path) ? resolve(root.path) : resolve(cwd, root.path)
}

/**
 * True only for paths under `rootPath`. A listing that escaped its root — via a
 * symlink or a `..` segment — must not become a deletion candidate: the sweeper
 * is allowed to delete inside the roots it was pointed at and nowhere else.
 */
export function isInside(rootPath: string, filePath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(filePath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function hasExtension(filePath: string, extensions: readonly string[]): boolean {
  if (extensions.length === 0) return true
  const lower = filePath.toLowerCase()
  return extensions.some((extension) => lower.endsWith(extension))
}

function listFiles(rootPath: string): ArchiveDirEntry[] {
  const entries: ArchiveDirEntry[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      // Symlinks are skipped rather than followed: a link inside the archive
      // could otherwise point the sweeper at a file outside it.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const stats = statSync(path)
      entries.push({ path, sizeBytes: stats.size, modifiedMs: stats.mtimeMs })
    }
  }
  walk(rootPath)
  return entries
}
