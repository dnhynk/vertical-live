import { describe, expect, it } from 'vitest'

import { MigrationError } from '../db/migrate.js'
import { classifyStoreFailure } from './db-integrity.js'

/**
 * Which database failures are §11's data-integrity safe stop (review round 1,
 * M3). The line that matters: a damaged file stops the run for a human, while a
 * busy lock or a full disk stays an operational condition §9.1 expects the run
 * to recover from.
 */

function sqliteError(code: string): Error {
  const error = new Error(`synthetic ${code}`)
  ;(error as Error & { code: string }).code = code
  return error
}

describe('classifyStoreFailure', () => {
  it('treats a damaged or non-database file as a data-integrity failure', () => {
    expect(classifyStoreFailure(sqliteError('SQLITE_CORRUPT'))).toEqual({
      integrity: true,
      reason: 'sqlite_sqlite_corrupt',
    })
    expect(classifyStoreFailure(sqliteError('SQLITE_NOTADB')).integrity).toBe(true)
    expect(classifyStoreFailure(sqliteError('SQLITE_CORRUPT_INDEX')).integrity).toBe(true)
  })

  it('treats an unverifiable migration history as a data-integrity failure', () => {
    // A recorded migration whose file is gone means the schema on disk was built
    // by something this checkout cannot account for.
    expect(classifyStoreFailure(new MigrationError('003 has no file')).integrity).toBe(true)
    expect(classifyStoreFailure(new MigrationError('003 has no file')).reason).toBe(
      'migration_history_unverifiable',
    )
  })

  it('leaves operational failures alone (spec §9.1 일시 장애)', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_IOERR_READ']) {
      const failure = classifyStoreFailure(sqliteError(code))
      expect(failure.integrity).toBe(false)
      expect(failure.reason).toBe(code.toLowerCase())
    }
  })

  it('reports a non-SQLite failure without claiming corruption', () => {
    expect(classifyStoreFailure(new Error('something else'))).toEqual({
      integrity: false,
      reason: 'store_error:other',
    })
  })
})
