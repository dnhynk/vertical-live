import type { ArchiveConfig } from './config.js'

/**
 * Which archive files to delete, and why — as one pure function.
 *
 * Spec §9.1 gives the product a "용량 제한이 있는 로컬 rolling archive"; §11
 * lists 최대 용량, 최소 여유공간, 보존, 자동 삭제 as the rules to approve before
 * the soak. Those are three separate rules, so the plan keeps them separate and
 * says which one condemned each file: an operator reading the report has to be
 * able to tell "this aged out" from "the disk was nearly full".
 *
 * Nothing here touches the filesystem. `sweep.ts` supplies the listing and the
 * free-space reading and then applies (or, in dry-run, prints) the plan, which
 * is what makes the ordering and the arithmetic testable without a disk.
 */

export interface ArchiveFile {
  /** `ArchiveRootConfig.name` this file was found under. */
  readonly root: string
  readonly path: string
  readonly sizeBytes: number
  /** Last modification, epoch milliseconds. */
  readonly modifiedMs: number
}

/**
 * `retention_days` — older than `archive.retentionDays`.
 * `max_total_bytes` — the archive's own footprint is over `archive.maxTotalBytes`.
 * `min_free_bytes` — the volume has less free space than `archive.minFreeBytes`.
 */
export type ArchiveDeleteReason = 'retention_days' | 'max_total_bytes' | 'min_free_bytes'

export interface ArchiveDeletion {
  readonly file: ArchiveFile
  readonly reason: ArchiveDeleteReason
}

export interface ArchiveSweepPlanInput {
  readonly config: ArchiveConfig
  readonly files: readonly ArchiveFile[]
  /** Free bytes on the volume that holds the roots, before any deletion. */
  readonly freeBytes: number
  /** Wall clock, epoch milliseconds. */
  readonly nowMs: number
}

export interface ArchiveSweepPlan {
  readonly scannedFiles: number
  readonly scannedBytes: number
  /** Files inside `activeFileGraceMs`; never candidates, still counted. */
  readonly protectedFiles: number
  readonly deletions: readonly ArchiveDeletion[]
  readonly reclaimBytes: number
  readonly totalBytesAfter: number
  readonly freeBytesAfter: number
  /**
   * Rules that still do not hold after every eligible file is gone. The sweeper
   * cannot delete its way out of a disk filled by something else, and saying so
   * is the honest outcome — silence would read as "the archive is within
   * budget" (spec §11 관측성).
   */
  readonly unmetRules: readonly ArchiveDeleteReason[]
}

const MS_PER_DAY = 86_400_000

export function planArchiveSweep(input: ArchiveSweepPlanInput): ArchiveSweepPlan {
  const { config, files, freeBytes, nowMs } = input

  const scannedBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const graceStartMs = nowMs - config.activeFileGraceMs
  const protectedFiles = files.filter((file) => file.modifiedMs > graceStartMs)

  // Oldest first, then by path: two files with the same mtime must be ordered
  // the same way on every run, or a dry-run report would not match the sweep
  // that follows it.
  const candidates = files
    .filter((file) => file.modifiedMs <= graceStartMs)
    .sort((left, right) => left.modifiedMs - right.modifiedMs || compare(left.path, right.path))

  const deletions: ArchiveDeletion[] = []
  const remaining: ArchiveFile[] = []
  let totalBytes = scannedBytes
  let reclaimBytes = 0

  const condemn = (file: ArchiveFile, reason: ArchiveDeleteReason): void => {
    deletions.push({ file, reason })
    totalBytes -= file.sizeBytes
    reclaimBytes += file.sizeBytes
  }

  const expiresBeforeMs = nowMs - config.retentionDays * MS_PER_DAY
  for (const file of candidates) {
    if (file.modifiedMs < expiresBeforeMs) {
      condemn(file, 'retention_days')
    } else {
      remaining.push(file)
    }
  }

  let index = 0
  while (totalBytes > config.maxTotalBytes && index < remaining.length) {
    condemn(remaining[index] as ArchiveFile, 'max_total_bytes')
    index += 1
  }

  while (freeBytes + reclaimBytes < config.minFreeBytes && index < remaining.length) {
    condemn(remaining[index] as ArchiveFile, 'min_free_bytes')
    index += 1
  }

  const unmetRules: ArchiveDeleteReason[] = []
  if (totalBytes > config.maxTotalBytes) unmetRules.push('max_total_bytes')
  if (freeBytes + reclaimBytes < config.minFreeBytes) unmetRules.push('min_free_bytes')

  return {
    scannedFiles: files.length,
    scannedBytes,
    protectedFiles: protectedFiles.length,
    deletions,
    reclaimBytes,
    totalBytesAfter: totalBytes,
    freeBytesAfter: freeBytes + reclaimBytes,
    unmetRules,
  }
}

function compare(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}
