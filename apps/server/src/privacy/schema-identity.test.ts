import { afterEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/index.js'
import {
  CONSENT_TABLE,
  IDENTITY_NAME_PARTS,
  findConsentIdentityColumns,
  findIdentityColumns,
  findIdentitySchemaText,
  matchIdentityPart,
  stripSqlComments,
} from './identity-columns.js'
import { createRetentionHarness, type RetentionHarness } from './testing/harness.js'

/**
 * TASK_SPECS §T13 acceptance 2, revised for BOARD D-9 (TASK_SPECS §T20b
 * acceptance 2): identity columns exist in **exactly one** table,
 * `viewer_consent`, and in no other.
 *
 * D-9 opened identity for viewers who send `JOIN`, so the original rule ("no
 * table anywhere has an author, channel or hash column") is now the rule for
 * every table except that one. The single-table property is what the deletion
 * promises rest on: `LEAVE`, a user deletion request and the 30-day sweep each
 * delete one row, and there is provably no second copy to chase.
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

describe('identity columns live in the consent table and nowhere else', () => {
  it('has no author, channel or hash column in any other table', () => {
    const active = open()
    const tables = active.store.listTables()

    // Guards the audit itself: an empty schema would make the assertion vacuous.
    expect(tables).toContain('ingest_inbox')
    expect(tables).toContain('retention_ledger')
    expect(tables).toContain(CONSENT_TABLE)
    expect(tables.length).toBeGreaterThan(8)
    const columnCount = tables.reduce(
      (sum, table) => sum + active.store.listColumns(table).length,
      0,
    )
    expect(columnCount).toBeGreaterThan(50)

    expect(findIdentityColumns(active.store)).toEqual([])
  })

  it('does hold the consented viewer identity in that one table (BOARD D-9)', () => {
    // The other half of the rule. Without this the audit would still pass on a
    // build where migration 006 silently stopped creating the table, and the
    // deletion paths would then quietly have nothing to delete.
    const active = open()
    expect(active.store.listColumns(CONSENT_TABLE)).toEqual([
      'channel_ref',
      'channel_id',
      'display_name',
      'consented_at',
      'last_active_at',
      'notice_version',
    ])
    expect(findConsentIdentityColumns(active.store).map((hit) => hit.column)).toEqual([
      'channel_ref',
      'channel_id',
      'display_name',
    ])
  })

  it('has no identity-shaped expression in any index or view either', () => {
    // A stable hash needs no column of its own: an expression index over a digest
    // would store one just as durably (spec §12.4 "가역 또는 안정적 hash"). The
    // consent table's own objects are exempt by name — and only those, so a new
    // index over a digest elsewhere is still caught.
    const active = open()
    const definitions = active.store.listSchemaDefinitions()
    expect(definitions.length).toBeGreaterThan(10)
    expect(definitions.map((entry) => entry.name)).toContain(CONSENT_TABLE)
    expect(findIdentitySchemaText(active.store)).toEqual([])
  })

  it('covers the three names §12.4 spells out', () => {
    for (const part of ['author', 'channel', 'hash']) {
      expect(IDENTITY_NAME_PARTS).toContain(part)
    }
  })

  it('finds an identity column when one exists outside the consent table', () => {
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
