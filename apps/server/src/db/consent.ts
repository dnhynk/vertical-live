import type Database from 'better-sqlite3'

import { PersistenceInvariantError } from './errors.js'
import { insertRetentionLedger, type RetentionLedgerEntry } from './retention.js'
import type { ConsentRecord, ConsentSelector } from './types.js'

/**
 * SQL for `viewer_consent`, the single store of a consented viewer's identity
 * (migration 006, BOARD D-9; spec §7.4, §12.4).
 *
 * Two rules shape every statement here:
 *
 * 1. **One row is the whole person.** There is no second table to join, so
 *    `LEAVE`, a user deletion request and the retention sweep all erase a
 *    viewer completely by deleting one row (spec §12.4 "해당 사용자와 관련해
 *    저장한 모든 user data").
 * 2. **A deletion records itself.** Every delete in this module commits its
 *    `retention_ledger` row inside the same transaction, the same rule T13's
 *    batched sweeps follow (`db/retention.ts`): data can never leave the
 *    database without the evidence that it was deleted, and the evidence can
 *    never claim a deletion that rolled back.
 *
 * No statement in this module logs, returns or accepts a value that identifies
 * a viewer other than through the arguments the caller already holds in memory.
 */

interface ConsentColumns {
  readonly channel_ref: string
  readonly channel_id: string
  readonly display_name: string
  readonly consented_at: string
  readonly last_active_at: string
  readonly notice_version: string
}

export interface ConsentDeleteResult {
  /** 0 when the selector matched nobody — a `LEAVE` from a viewer who never joined. */
  readonly rowsDeleted: number
  readonly ledgerEntryId: number
}

/** Audit row for a deletion, built from the row count it is committed with. */
export type ConsentDeleteAudit = (counts: { rowsDeleted: number }) => RetentionLedgerEntry

function toRecord(row: ConsentColumns): ConsentRecord {
  return {
    channelRef: row.channel_ref,
    channelId: row.channel_id,
    displayName: row.display_name,
    consentedAt: row.consented_at,
    lastActiveAt: row.last_active_at,
    noticeVersion: row.notice_version,
  }
}

const SELECT_COLUMNS =
  'SELECT channel_ref, channel_id, display_name, consented_at, last_active_at, notice_version FROM viewer_consent'

/**
 * Records consent, or renews it when the same viewer sends the opt-in command
 * again.
 *
 * A repeat opt-in keeps the `channel_ref` already issued: the reference is what
 * the renderer may see, and re-rolling it on every `JOIN` would leave the same
 * person behind two references in one broadcast for no benefit. `consented_at`
 * and `notice_version` *are* rewritten, because a second `JOIN` is a fresh
 * agreement — possibly to a newer notice text (docs/ops/identity-consent.md).
 */
export function upsertConsent(database: Database.Database, record: ConsentRecord): ConsentRecord {
  database
    .prepare(
      `INSERT INTO viewer_consent
         (channel_ref, channel_id, display_name, consented_at, last_active_at, notice_version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         display_name   = excluded.display_name,
         consented_at   = excluded.consented_at,
         last_active_at = excluded.last_active_at,
         notice_version = excluded.notice_version`,
    )
    .run(
      record.channelRef,
      record.channelId,
      record.displayName,
      record.consentedAt,
      record.lastActiveAt,
      record.noticeVersion,
    )
  const stored = findConsentByChannelId(database, record.channelId)
  if (stored === null) {
    throw new PersistenceInvariantError('consent row disappeared immediately after being written')
  }
  return stored
}

export function findConsentByChannelId(
  database: Database.Database,
  channelId: string,
): ConsentRecord | null {
  const row = database
    .prepare<[string], ConsentColumns>(`${SELECT_COLUMNS} WHERE channel_id = ?`)
    .get(channelId)
  return row === undefined ? null : toRecord(row)
}

export function findConsentByChannelRef(
  database: Database.Database,
  channelRef: string,
): ConsentRecord | null {
  const row = database
    .prepare<[string], ConsentColumns>(`${SELECT_COLUMNS} WHERE channel_ref = ?`)
    .get(channelRef)
  return row === undefined ? null : toRecord(row)
}

/**
 * Refreshes the two Authorized Data columns from the message that just arrived.
 *
 * This is the refresh [S41] Developer Policies III.E.4.c requires ("no longer
 * than 30 calendar days"): the stored name and channel id are re-read from the
 * API on every message the viewer sends, and `last_active_at` records when. A
 * viewer who stops sending stops being refreshed, and the retention sweep then
 * deletes the row.
 *
 * @returns false when the viewer has no consent record (they left, or the sweep
 * already deleted them), which the caller must treat as "not consented".
 */
export function refreshConsent(
  database: Database.Database,
  input: { channelId: string; displayName: string; lastActiveAt: string },
): boolean {
  const result = database
    .prepare(`UPDATE viewer_consent SET display_name = ?, last_active_at = ? WHERE channel_id = ?`)
    .run(input.displayName, input.lastActiveAt, input.channelId)
  return result.changes > 0
}

/**
 * Deletes one viewer's consent row and commits the audit row with it.
 *
 * Used by the withdrawal command and by the user deletion request handler; both
 * delete immediately rather than within the policy window, so the recorded
 * `deadline_at` is the deadline the obligation *had*, not when it ran.
 */
export function deleteConsent(
  database: Database.Database,
  selector: ConsentSelector,
  audit: ConsentDeleteAudit,
): ConsentDeleteResult {
  if (typeof audit !== 'function') {
    throw new PersistenceInvariantError(
      'a consent deletion must be given an audit factory: deleting without committing the evidence is not allowed (spec §12.4)',
    )
  }
  const [column, value] =
    'channelRef' in selector
      ? (['channel_ref', selector.channelRef] as const)
      : (['channel_id', selector.channelId] as const)

  const run = database.transaction((): ConsentDeleteResult => {
    const deleted = database.prepare(`DELETE FROM viewer_consent WHERE ${column} = ?`).run(value)
    const rowsDeleted = deleted.changes
    const ledgerEntryId = insertRetentionLedger(database, audit({ rowsDeleted }))
    return { rowsDeleted, ledgerEntryId }
  })
  return run.immediate()
}
