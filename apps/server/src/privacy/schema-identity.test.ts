import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/index.js'
import {
  IDENTITY_NAME_PARTS,
  findIdentityColumns,
  findIdentitySchemaText,
  matchIdentityPart,
  stripSqlComments,
} from './identity-columns.js'
import { createRetentionHarness, type RetentionHarness } from './testing/harness.js'

/**
 * TASK_SPECS §T13 acceptance 2: no table in the whole schema has an author,
 * channel or hash column (spec §7.4, §12.4, BOARD A-1).
 *
 * The audit runs against a *migrated database*, not against the migration files:
 * what matters is the schema the server actually opens, including anything a
 * later migration adds.
 */

let harness: RetentionHarness | undefined

afterEach(() => {
  harness?.dispose()
  harness = undefined
})

function open(): RetentionHarness {
  harness = createRetentionHarness()
  return harness
}

describe('the persisted schema cannot hold a personal identifier', () => {
  it('has no author, channel or hash column in any table', () => {
    const active = open()
    const tables = active.store.listTables()

    // Guards the audit itself: an empty schema would make the assertion vacuous.
    expect(tables).toContain('ingest_inbox')
    expect(tables).toContain('retention_ledger')
    expect(tables.length).toBeGreaterThan(8)
    const columnCount = tables.reduce(
      (sum, table) => sum + active.store.listColumns(table).length,
      0,
    )
    expect(columnCount).toBeGreaterThan(50)

    expect(findIdentityColumns(active.store)).toEqual([])
  })

  it('has no identity-shaped expression in any index or view either', () => {
    // A stable hash needs no column of its own: an expression index over a digest
    // would store one just as durably (spec §12.4 "가역 또는 안정적 hash").
    const active = open()
    const definitions = active.store.listSchemaDefinitions()
    expect(definitions.length).toBeGreaterThan(10)
    expect(findIdentitySchemaText(active.store)).toEqual([])
  })

  it('covers the three names §12.4 spells out', () => {
    for (const part of ['author', 'channel', 'hash']) {
      expect(IDENTITY_NAME_PARTS).toContain(part)
    }
  })

  it('finds an identity column when one exists', () => {
    // Positive control: without this, a broken audit would report a clean schema.
    const active = open()
    const database = openDatabase({ file: active.temp.file, busyTimeoutMs: 1000 })
    try {
      database.exec('CREATE TABLE probe_table (author_channel_id TEXT PRIMARY KEY) STRICT')
    } finally {
      database.close()
    }

    expect(findIdentityColumns(active.store)).toEqual([
      { table: 'probe_table', column: 'author_channel_id', matched: 'author' },
    ])
    expect(findIdentitySchemaText(active.store).map((hit) => hit.object)).toContain('probe_table')
  })

  it('ignores the rule written in a comment but not a real identifier', () => {
    // `001_initial.sql` documents "no column for an author …" inside the statements
    // it constrains. Matching documentation would make the audit fire on the very
    // sentence that states the invariant.
    expect(matchIdentityPart(stripSqlComments('CREATE TABLE t (a TEXT) -- no author here'))).toBe(
      undefined,
    )
    expect(matchIdentityPart(stripSqlComments('CREATE TABLE t (author TEXT)'))).toBe('author')
    expect(stripSqlComments('a /* author */ b')).toBe('a   b')
  })
})
