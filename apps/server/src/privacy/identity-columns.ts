import type { PersistenceStore } from '../db/index.js'

/**
 * Audits the live SQL schema for a place a personal identifier could be stored
 * (spec §12.4: "사용자명·channel ID·가역 또는 안정적 hash를 저장하지 않고"; §7.4:
 * "승인 전에는 `authorDetails`를 저장하지 않고"; BOARD A-1).
 *
 * `packages/contract/src/privacy.test.ts` already proves no *contract* type has
 * such a field. This module answers the other half: whatever the contract says,
 * the database itself must have nowhere to put one. It is used by the T13
 * acceptance test and by the user-deletion-request handler, which has to be able
 * to state — from the schema, not from a comment — that nothing about a person is
 * stored.
 */

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

/** Every column of every table whose name looks like a personal identifier. */
export function findIdentityColumns(store: PersistenceStore): IdentityColumnHit[] {
  const hits: IdentityColumnHit[] = []
  for (const table of store.listTables()) {
    for (const column of store.listColumns(table)) {
      const matched = matchIdentityPart(column)
      if (matched !== undefined) hits.push({ table, column, matched })
    }
  }
  return hits
}

/**
 * Same audit over the `CREATE` text of every schema object, so a computed value
 * — an expression index over a digest, a view that concatenates ids — is caught
 * even though it declares no column of its own. §12.4 forbids storing a stable
 * hash, and a stable hash needs no column name to exist.
 *
 * Comments are stripped first: `001_initial.sql` documents the rule inside the
 * statements it constrains, and matching documentation would make this audit
 * fire on the very sentence that states the invariant.
 */
export function findIdentitySchemaText(store: PersistenceStore): IdentitySchemaTextHit[] {
  const hits: IdentitySchemaTextHit[] = []
  for (const { name, sql } of store.listSchemaDefinitions()) {
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
