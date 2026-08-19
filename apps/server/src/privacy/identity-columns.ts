import type { PersistenceStore } from '../db/index.js'

/**
 * Audits the live SQL schema for a place a personal identifier could be stored
 * (spec §12.4: "사용자명·channel ID·가역 또는 안정적 hash를 저장하지 않고"; §7.4;
 * BOARD A-1, partially reversed by D-9).
 *
 * `packages/contract/src/privacy.test.ts` already proves no *contract* type has
 * such a field. This module answers the other half: whatever the contract says,
 * the database must have nowhere to put one — with exactly one exception.
 *
 * D-9 opened identity for viewers who opt in, so the rule is no longer "nowhere"
 * but **"one place"**: `viewer_consent` (migration 006) holds the consenting
 * viewer's channel id and display name, and every other table in the schema is
 * still audited as before. That single-table rule is what makes the D-9 deletion
 * promises checkable — `LEAVE`, a user deletion request and the retention sweep
 * each delete one row, and there is provably no copy anywhere else
 * (TASK_SPECS §T20b acceptance 2).
 */

/**
 * The one table allowed to hold identity-shaped columns (BOARD D-9, migration
 * 006). Named here rather than in the retention config because this module is
 * what decides where identity may live; `config/retention.json` then has to
 * declare a schedule for it.
 */
export const CONSENT_TABLE = 'viewer_consent'

/**
 * Schema objects that belong to the consent table and are therefore exempt from
 * the text audit as well: the table itself and every index over it. Listed by
 * name rather than by prefix so a *new* object cannot join the exemption by
 * being called `viewer_consent_something`.
 */
export const CONSENT_SCHEMA_OBJECTS: readonly string[] = [
  CONSENT_TABLE,
  'viewer_consent_last_active',
]

/**
 * Substrings that may not appear in a column name or in a schema expression,
 * case-insensitively. `author`, `channel` and `hash` are the three §12.4 names;
 * the rest close the routes the same value travels under another label.
 */
export const IDENTITY_NAME_PARTS: readonly string[] = [
  'author',
  'channel',
  'hash',
  'displayname',
  'display_name',
  'username',
  'user_name',
  'nickname',
  'nick_name',
  'profile',
  'avatar',
  'email',
  'handle',
  'fingerprint',
  'ip_address',
  'ipaddress',
  'messagetext',
  'message_text',
  'rawtext',
  'raw_text',
  'chattext',
  'chat_text',
  'usercomment',
  'user_comment',
]

export interface IdentityColumnHit {
  readonly table: string
  readonly column: string
  readonly matched: string
}

export interface IdentitySchemaTextHit {
  readonly object: string
  readonly matched: string
}

/**
 * Every column outside the consent table whose name looks like a personal
 * identifier. A hit is a policy violation; the consent table is skipped because
 * D-9 put identity there on purpose.
 */
export function findIdentityColumns(store: PersistenceStore): IdentityColumnHit[] {
  const hits: IdentityColumnHit[] = []
  for (const table of store.listTables()) {
    if (table === CONSENT_TABLE) continue
    for (const column of store.listColumns(table)) {
      const matched = matchIdentityPart(column)
      if (matched !== undefined) hits.push({ table, column, matched })
    }
  }
  return hits
}

/**
 * The consent table's own identity columns, i.e. what a deletion has to erase.
 * Empty before migration 006 has run or on a build where the table was dropped.
 */
export function findConsentIdentityColumns(store: PersistenceStore): IdentityColumnHit[] {
  return store
    .listColumns(CONSENT_TABLE)
    .flatMap((column) => {
      const matched = matchIdentityPart(column)
      return matched === undefined ? [] : [{ table: CONSENT_TABLE, column, matched }]
    })
}

/**
 * Same audit over the `CREATE` text of every schema object except the consent
 * table's own, so a computed value — an expression index over a digest, a view
 * that concatenates ids — is caught even though it declares no column of its
 * own. §12.4 forbids storing a stable hash, and a stable hash needs no column
 * name to exist. That rule holds for the consent table too: `channel_ref` is
 * 128 random bits, not a digest of the channel id (migration 006).
 *
 * Comments are stripped first: `001_initial.sql` documents the rule inside the
 * statements it constrains, and matching documentation would make this audit
 * fire on the very sentence that states the invariant.
 */
export function findIdentitySchemaText(store: PersistenceStore): IdentitySchemaTextHit[] {
  const hits: IdentitySchemaTextHit[] = []
  for (const { name, sql } of store.listSchemaDefinitions()) {
    if (CONSENT_SCHEMA_OBJECTS.includes(name)) continue
    const matched = matchIdentityPart(stripSqlComments(sql))
    if (matched !== undefined) hits.push({ object: name, matched })
  }
  return hits
}

/** First forbidden substring in `text`, or `undefined` when it is clean. */
export function matchIdentityPart(text: string): string | undefined {
  const lowered = text.toLowerCase()
  return IDENTITY_NAME_PARTS.find((part) => lowered.includes(part))
}

/** Removes SQL line comments and block comments from a schema definition. */
export function stripSqlComments(sql: string): string {
  return sql.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/--[^\n]*/g, ' ')
}
