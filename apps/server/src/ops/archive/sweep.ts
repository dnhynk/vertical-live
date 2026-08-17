import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
} from 'node:fs'
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
 *
 * **Every path is decided on its canonical form.** Comparing the lexical path
 * of a listing against the lexical path of its root proves nothing on Windows:
 * a configured root that is itself a junction reports the *target's* files under
 * the link's path, and a delete then removes files the operator never pointed
 * this at (review round 1, B1). So a root that is a reparse point is refused
 * outright, everything else is compared after `realpath`, and the check is made
 * again immediately before each delete — the file could have been replaced by a
 * link between the scan and the delete.
 */

export interface ArchiveDirEntry {
  readonly path: string
  readonly sizeBytes: number
  readonly modifiedMs: number
}

export interface ArchiveFsPort {
  exists(path: string): boolean
  /**
   * True when the path itself is a symlink or a Windows junction (both are
   * reparse points, and libuv reports both through `lstat().isSymbolicLink()`).
   * Must not follow the link.
   */
  isLink(path: string): boolean
  /** Canonical path with every link resolved. Throws when it cannot resolve. */
  realPath(path: string): string
  /** Regular files under `rootPath`, recursively. Symlinks are not followed. */
  list(rootPath: string): readonly ArchiveDirEntry[]
  remove(path: string): void
  /** Free bytes on the volume holding `path`. */
  freeBytes(path: string): number
}

export const nodeArchiveFs: ArchiveFsPort = {
  exists: (path) => existsSync(path),
  isLink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      // Unreadable is not "not a link": callers treat a failed check as a
      // refusal rather than as permission to delete.
      return true
    }
  },
  realPath: (path) => realpathSync.native(path),
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
  /** Canonical path the sweep used, or `null` when the root was refused. */
  readonly realPath: string | null
  /**
   * Why the root was skipped without being swept: `reparse_point` (the root is
   * a junction or symlink) or `unresolvable` (its canonical path cannot be
   * read). `null` when the root was swept normally.
   */
  readonly refused: string | null
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
  /** Canonical root per root name; the delete-time guard compares against it. */
  const realRoots = new Map<string, string>()

  for (const root of options.config.roots) {
    const rootPath = resolveRoot(root, cwd)
    if (!fs.exists(rootPath)) {
      roots.push(missingRoot(root.name, rootPath))
      continue
    }

    // A root that is itself a reparse point is refused rather than resolved:
    // "inside the root" would then mean "inside whatever the link points at
    // today", which is not something an operator can review in config
    // (review round 1, B1).
    if (fs.isLink(rootPath)) {
      logger.error('archive root refused: it is a symlink or junction', {
        root: root.name,
        path: rootPath,
      })
      roots.push(refusedRoot(root.name, rootPath, 'reparse_point'))
      continue
    }

    let realRoot: string
    try {
      realRoot = fs.realPath(rootPath)
    } catch (error) {
      logger.error('archive root refused: its canonical path is unreadable', {
        root: root.name,
        path: rootPath,
        error: error instanceof Error ? error.message : String(error),
      })
      roots.push(refusedRoot(root.name, rootPath, 'unresolvable'))
      continue
    }
    realRoots.set(root.name, realRoot)

    const found: ArchiveFile[] = []
    for (const entry of fs.list(rootPath)) {
      if (!hasExtension(entry.path, root.extensions)) continue
      const target = canonicalTarget(fs, realRoot, entry.path)
      if (target === null) {
        logger.warn('archive entry skipped: it does not resolve inside its root', {
          root: root.name,
          path: entry.path,
        })
        continue
      }
      found.push({
        root: root.name,
        path: target,
        sizeBytes: entry.sizeBytes,
        modifiedMs: entry.modifiedMs,
      })
    }

    let freeBytes: number | null = null
    try {
      freeBytes = fs.freeBytes(realRoot)
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
      realPath: realRoot,
      refused: null,
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
      const realRoot = realRoots.get(deletion.file.root)
      // The scan and the delete are two moments. Between them the file can be
      // replaced by a link to somewhere else, so the canonical check is made
      // again here and a file that no longer resolves inside its root is
      // reported instead of deleted (review round 1, B1).
      const target =
        realRoot === undefined ? null : canonicalTarget(fs, realRoot, deletion.file.path)
      if (target === null) {
        logger.error('archive delete refused: the target no longer resolves inside its root', {
          root: deletion.file.root,
          path: deletion.file.path,
        })
        failed.push({ path: deletion.file.path, error: 'path_escaped_root' })
        continue
      }
      try {
        fs.remove(target)
        deleted.push(target)
      } catch (error) {
        failed.push({
          path: target,
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
 * The canonical path this sweeper is allowed to delete, or `null` when the path
 * is a link or does not resolve inside `realRoot`.
 *
 * Both halves matter. The link check refuses a candidate whose *name* is inside
 * the root while its content lives elsewhere; the `realpath` comparison refuses
 * one whose parent directory is a link. Anything this returns has been resolved,
 * so the caller deletes the path that was actually checked rather than the one
 * that was listed.
 */
export function canonicalTarget(
  fs: ArchiveFsPort,
  realRoot: string,
  filePath: string,
): string | null {
  if (fs.isLink(filePath)) return null
  let real: string
  try {
    real = fs.realPath(filePath)
  } catch {
    return null
  }
  return isInside(realRoot, real) ? real : null
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

function missingRoot(name: string, path: string): ArchiveRootReport {
  return {
    name,
    path,
    exists: false,
    realPath: null,
    refused: null,
    files: 0,
    bytes: 0,
    freeBytes: null,
  }
}

function refusedRoot(name: string, path: string, refused: string): ArchiveRootReport {
  return { name, path, exists: true, realPath: null, refused, files: 0, bytes: 0, freeBytes: null }
}

function listFiles(rootPath: string): ArchiveDirEntry[] {
  const entries: ArchiveDirEntry[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      // Symlinks and junctions are skipped rather than followed: a link inside
      // the archive could otherwise point the sweeper at a file outside it.
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
