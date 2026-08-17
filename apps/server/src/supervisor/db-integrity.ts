import { classifySqliteError } from '../db/errors.js'
import { MigrationError } from '../db/migrate.js'

/**
 * Which database failures are the `data_integrity` safe-stop of spec §11
 * ("권리·정책·데이터 무결성 오류에서 자동 재시작 대신 kill switch와 알림이
 * 동작함") and TASK_SPECS §T12.
 *
 * Two kinds qualify, and only two (review round 1, M3):
 *
 * - **the file is damaged or is not a database** — `SQLITE_CORRUPT*`,
 *   `SQLITE_NOTADB`. T4 already classifies these as `corrupt` and its own
 *   comment says they require `safe_stopped`; this is where that is acted on.
 * - **the applied migration history cannot be verified** — a recorded migration
 *   whose file is gone or renamed, or a file whose checksum changed after it was
 *   applied. The schema on disk was then built by something this checkout cannot
 *   account for, so the state is not trustworthy.
 *
 * A busy lock, a read-only file, a full disk or a host I/O error are **not**
 * integrity failures: they are operational conditions an operator can clear, and
 * turning them into an unrestartable stop would be the opposite of §9.1's
 * "일시 장애 자동 복구".
 */

export interface StoreFailure {
  /** True when this is the `data_integrity` case (spec §11 안전 정지). */
  readonly integrity: boolean
  /** Machine-stable token; never a file path or a SQL fragment. */
  readonly reason: string
}

export function classifyStoreFailure(error: unknown): StoreFailure {
  if (error instanceof MigrationError) {
    return { integrity: true, reason: 'migration_history_unverifiable' }
  }
  const failure = classifySqliteError(error)
  if (failure.kind === 'corrupt') {
    return { integrity: true, reason: `sqlite_${failure.code ?? 'corrupt'}`.toLowerCase() }
  }
  return {
    integrity: false,
    reason: failure.code === null ? `store_error:${failure.kind}` : failure.code.toLowerCase(),
  }
}
