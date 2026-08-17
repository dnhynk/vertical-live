import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { RetentionPolicyKind, RetentionSource } from '../db/index.js'
import type { AuthRevokedReason } from '../youtube/auth/events.js'

/**
 * Loader for `config/retention.json` — the field-level retention schedule spec
 * §12.4 requires ("보존은 단일 '30일' 규칙으로 축약하지 않고 field별 schedule로
 * 관리한다").
 *
 * The loader is deliberately strict. Every rule §12.4 states as a maximum is
 * checked here rather than trusted from the file, so a config edit cannot quietly
 * widen a policy window:
 *
 * - Authorized API Data must be deleted, and within `sourceDataRetentionDays`.
 *   `refresh` is not accepted for it: the spec allows "refresh or delete", but
 *   this system has no path that re-fetches a past live-chat item, so declaring
 *   `refresh` would be a promise the sweeper cannot keep.
 * - A client-side consent withdrawal and a user deletion request may allow at
 *   most 7 days; a provider-side revocation at most 30 (spec §12.4).
 * - Every field must declare `personalIdentifiers: "none"`. While the identity
 *   gate is closed the schema has no column for a name, a channel id or a stable
 *   hash at all (spec §7.4, §12.4, BOARD A-1), so a config that claims otherwise
 *   is a bug in the config, not a new policy.
 * - Unknown keys are rejected, so a misspelled `allowedPeriodDays` cannot fall
 *   back to a default.
 */

export type RetentionDataClass = 'authorized_api_data' | 'derived_state' | 'identifier_free_aggregate'
export type RetentionFieldStatus = 'present' | 'planned'
/** Which §12.4 window a revocation falls under. */
export type RevocationClass = 'client_side' | 'provider_side'

export type RetentionExpiry =
  | { readonly kind: 'column'; readonly column: string }
  | { readonly kind: 'orphan'; readonly referencesTable: string }

interface RetentionFieldCommon {
  readonly key: string
  readonly table: string
  readonly status: RetentionFieldStatus
  /** Task that will create the table; only for `status: "planned"`. */
  readonly plannedBy?: string
  readonly source: RetentionSource
  readonly dataClass: RetentionDataClass
  readonly purpose: string
  readonly storedColumns: readonly string[]
  readonly personalIdentifiers: 'none'
  readonly expiry: RetentionExpiry
  /** A row whose column is NULL had not finished when it was deleted. */
  readonly unfinishedColumn?: string
  readonly specRef: string
}

export interface RetentionDeleteField extends RetentionFieldCommon {
  readonly policy: 'delete'
  readonly allowedPeriodDays: number
}

export interface RetentionRefreshField extends RetentionFieldCommon {
  readonly policy: 'refresh'
  readonly allowedPeriodDays: null
  /** How often the permission and the deletion decision are re-checked. */
  readonly reverifyPeriodDays: number
}

export type RetentionField = RetentionDeleteField | RetentionRefreshField

export interface RetentionSweepConfig {
  readonly intervalMs: number
  readonly batchLimit: number
  readonly maxBatchesPerEntry: number
  readonly provisional: readonly string[]
}

export interface RevocationConfig {
  readonly clientSideDeletionDays: number
  readonly providerSideDeletionDays: number
  readonly userRequestDeletionDays: number
  readonly reasonClass: Readonly<Record<AuthRevokedReason, RevocationClass>>
}

export interface SchemaOnlyTable {
  readonly table: string
  readonly reason: string
}

export interface RetentionConfig {
  readonly version: 1
  /** The §12.4 ceiling for general Authorized/Non-Authorized API Data. */
  readonly sourceDataRetentionDays: number
  readonly sweep: RetentionSweepConfig
  readonly revocation: RevocationConfig
  readonly fields: readonly RetentionField[]
  readonly schemaOnlyTables: readonly SchemaOnlyTable[]
}

/** `config/retention.json` at the repository root, from `src/…` or `dist/…`. */
export const DEFAULT_RETENTION_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/retention.json', import.meta.url),
)

export const RETENTION_CONFIG_ENV = 'VL_RETENTION_CONFIG'

/** §12.4 maxima. Not configurable: they are the policy, not a tuning knob. */
export const POLICY_MAX_SOURCE_DATA_DAYS = 30
export const POLICY_MAX_CLIENT_SIDE_DELETION_DAYS = 7
export const POLICY_MAX_PROVIDER_SIDE_DELETION_DAYS = 30
export const POLICY_MAX_USER_REQUEST_DELETION_DAYS = 7

export class RetentionConfigError extends Error {
  constructor(message: string) {
    super(`invalid retention config: ${message}`)
    this.name = 'RetentionConfigError'
  }
}

/**
 * Every `AuthRevokedReason` must be classified. Written as a total record so
 * adding a reason to T3's union is a compile error here rather than a silent
 * fall-through to the wider window.
 */
const REASON_KEYS: Readonly<Record<AuthRevokedReason, true>> = {
  operator_revoked: true,
  invalid_grant: true,
  missing_refresh_token: true,
}
export const AUTH_REVOKED_REASONS = Object.keys(REASON_KEYS) as readonly AuthRevokedReason[]

const SOURCES: readonly RetentionSource[] = ['youtube_api', 'simulator', 'internal']
const DATA_CLASSES: readonly RetentionDataClass[] = [
  'authorized_api_data',
  'derived_state',
  'identifier_free_aggregate',
]
const POLICIES: readonly RetentionPolicyKind[] = ['delete', 'refresh']
const STATUSES: readonly RetentionFieldStatus[] = ['present', 'planned']
const REVOCATION_CLASSES: readonly RevocationClass[] = ['client_side', 'provider_side']

const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/
const FIELD_KEY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

export interface LoadRetentionConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadRetentionConfig(options: LoadRetentionConfigOptions = {}): RetentionConfig {
  const env = options.env ?? process.env
  const fromEnv = env[RETENTION_CONFIG_ENV]
  const configPath =
    options.configPath ??
    (fromEnv === undefined || fromEnv === '' ? DEFAULT_RETENTION_CONFIG_PATH : fromEnv)

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new RetentionConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }
  return parseRetentionConfig(parsed)
}

/** Validates an already-parsed document. Exported so tests need no temp file. */
export function parseRetentionConfig(document: unknown): RetentionConfig {
  const root = asObject(document, 'root')
  rejectUnknownKeys(root, 'root', [
    'version',
    'sourceDataRetentionDays',
    'sweep',
    'revocation',
    'fields',
    'schemaOnlyTables',
  ])

  const version = readPositiveInt(root['version'], 'version')
  if (version !== 1) {
    throw new RetentionConfigError(`unsupported version ${String(version)}; this loader reads 1`)
  }
  const sourceDataRetentionDays = readPositiveInt(
    root['sourceDataRetentionDays'],
    'sourceDataRetentionDays',
  )
  if (sourceDataRetentionDays > POLICY_MAX_SOURCE_DATA_DAYS) {
    throw new RetentionConfigError(
      `sourceDataRetentionDays ${String(sourceDataRetentionDays)} exceeds the ${String(POLICY_MAX_SOURCE_DATA_DAYS)}-day policy maximum (spec §12.4)`,
    )
  }

  const fields = readArray(root['fields'], 'fields').map((entry, index) =>
    parseField(entry, `fields[${String(index)}]`, sourceDataRetentionDays),
  )
  if (fields.length === 0) {
    throw new RetentionConfigError('fields must not be empty')
  }
  assertUnique(
    fields.map((field) => field.key),
    'fields[].key',
  )
  assertUnique(
    fields.map((field) => field.table),
    'fields[].table',
  )

  const schemaOnlyTables = readArray(root['schemaOnlyTables'], 'schemaOnlyTables').map(
    (entry, index) => parseSchemaOnlyTable(entry, `schemaOnlyTables[${String(index)}]`),
  )
  assertUnique(
    schemaOnlyTables.map((entry) => entry.table),
    'schemaOnlyTables[].table',
  )
  const fieldTables = new Set(fields.map((field) => field.table))
  for (const entry of schemaOnlyTables) {
    if (fieldTables.has(entry.table)) {
      throw new RetentionConfigError(
        `${entry.table} is declared both as a retention field and as a schema-only table`,
      )
    }
  }

  return Object.freeze({
    version: 1,
    sourceDataRetentionDays,
    sweep: parseSweep(root['sweep']),
    revocation: parseRevocation(root['revocation']),
    fields: Object.freeze(fields),
    schemaOnlyTables: Object.freeze(schemaOnlyTables),
  })
}

function parseSweep(value: unknown): RetentionSweepConfig {
  const section = asObject(value, 'sweep')
  const keys = ['intervalMs', 'batchLimit', 'maxBatchesPerEntry', 'provisional']
  rejectUnknownKeys(section, 'sweep', keys)
  const provisional = readStringArray(section['provisional'], 'sweep.provisional')
  for (const name of provisional) {
    if (!keys.includes(name) || name === 'provisional') {
      throw new RetentionConfigError(`sweep.provisional names ${name}, which is not a sweep setting`)
    }
  }
  return Object.freeze({
    intervalMs: readPositiveInt(section['intervalMs'], 'sweep.intervalMs'),
    batchLimit: readPositiveInt(section['batchLimit'], 'sweep.batchLimit'),
    maxBatchesPerEntry: readPositiveInt(
      section['maxBatchesPerEntry'],
      'sweep.maxBatchesPerEntry',
    ),
    provisional: Object.freeze(provisional),
  })
}

function parseRevocation(value: unknown): RevocationConfig {
  const section = asObject(value, 'revocation')
  rejectUnknownKeys(section, 'revocation', [
    'clientSideDeletionDays',
    'providerSideDeletionDays',
    'userRequestDeletionDays',
    'reasonClass',
  ])
  const clientSideDeletionDays = readPositiveInt(
    section['clientSideDeletionDays'],
    'revocation.clientSideDeletionDays',
  )
  const providerSideDeletionDays = readPositiveInt(
    section['providerSideDeletionDays'],
    'revocation.providerSideDeletionDays',
  )
  const userRequestDeletionDays = readPositiveInt(
    section['userRequestDeletionDays'],
    'revocation.userRequestDeletionDays',
  )
  assertAtMost(
    clientSideDeletionDays,
    POLICY_MAX_CLIENT_SIDE_DELETION_DAYS,
    'revocation.clientSideDeletionDays',
    'client-side consent 철회는 … 최대 7일 안에 삭제한다',
  )
  assertAtMost(
    providerSideDeletionDays,
    POLICY_MAX_PROVIDER_SIDE_DELETION_DAYS,
    'revocation.providerSideDeletionDays',
    'Google 설정에서의 권한 철회는 정책의 별도 최대 30일 규칙을 적용한다',
  )
  assertAtMost(
    userRequestDeletionDays,
    POLICY_MAX_USER_REQUEST_DELETION_DAYS,
    'revocation.userRequestDeletionDays',
    '사용자 삭제·계정 삭제 요청은 … 최대 7일 안에 삭제한다',
  )

  const reasonSection = asObject(section['reasonClass'], 'revocation.reasonClass')
  rejectUnknownKeys(reasonSection, 'revocation.reasonClass', [...AUTH_REVOKED_REASONS])
  const reasonClass: Record<string, RevocationClass> = {}
  for (const reason of AUTH_REVOKED_REASONS) {
    const raw = reasonSection[reason]
    if (typeof raw !== 'string' || !REVOCATION_CLASSES.includes(raw as RevocationClass)) {
      throw new RetentionConfigError(
        `revocation.reasonClass.${reason} must be one of ${REVOCATION_CLASSES.join(', ')}`,
      )
    }
    reasonClass[reason] = raw as RevocationClass
  }

  return Object.freeze({
    clientSideDeletionDays,
    providerSideDeletionDays,
    userRequestDeletionDays,
    reasonClass: Object.freeze(reasonClass) as Readonly<Record<AuthRevokedReason, RevocationClass>>,
  })
}

function parseField(value: unknown, label: string, sourceDataRetentionDays: number): RetentionField {
  const entry = asObject(value, label)
  rejectUnknownKeys(entry, label, [
    'key',
    'table',
    'status',
    'plannedBy',
    'source',
    'dataClass',
    'purpose',
    'storedColumns',
    'personalIdentifiers',
    'policy',
    'allowedPeriodDays',
    'reverifyPeriodDays',
    'expiry',
    'unfinishedColumn',
    'specRef',
  ])

  const key = readString(entry['key'], `${label}.key`)
  if (!FIELD_KEY.test(key)) {
    throw new RetentionConfigError(`${label}.key must look like table.field, got ${key}`)
  }
  const table = readIdentifier(entry['table'], `${label}.table`)
  const status = readEnum(entry['status'], `${label}.status`, STATUSES)
  const plannedBy = entry['plannedBy']
  if (status === 'planned' && typeof plannedBy !== 'string') {
    throw new RetentionConfigError(`${label}.plannedBy must name the task that creates ${table}`)
  }
  if (status === 'present' && plannedBy !== undefined) {
    throw new RetentionConfigError(`${label}.plannedBy is only for status "planned"`)
  }
  const source = readEnum(entry['source'], `${label}.source`, SOURCES)
  const dataClass = readEnum(entry['dataClass'], `${label}.dataClass`, DATA_CLASSES)
  const purpose = readString(entry['purpose'], `${label}.purpose`)
  const specRef = readString(entry['specRef'], `${label}.specRef`)
  const storedColumns = readStringArray(entry['storedColumns'], `${label}.storedColumns`)
  for (const column of storedColumns) readIdentifier(column, `${label}.storedColumns[]`)

  if (entry['personalIdentifiers'] !== 'none') {
    throw new RetentionConfigError(
      `${label}.personalIdentifiers must be "none": while the identity gate is closed no field may hold a user name, channel id or stable hash (spec §7.4, §12.4, BOARD A-1)`,
    )
  }

  const expiry = parseExpiry(entry['expiry'], `${label}.expiry`)
  const unfinishedColumnRaw = entry['unfinishedColumn']
  const unfinishedColumn =
    unfinishedColumnRaw === undefined
      ? undefined
      : readIdentifier(unfinishedColumnRaw, `${label}.unfinishedColumn`)

  const common: RetentionFieldCommon = {
    key,
    table,
    status,
    ...(plannedBy === undefined ? {} : { plannedBy: plannedBy as string }),
    source,
    dataClass,
    purpose,
    storedColumns: Object.freeze(storedColumns),
    personalIdentifiers: 'none',
    expiry,
    ...(unfinishedColumn === undefined ? {} : { unfinishedColumn }),
    specRef,
  }

  const policy = readEnum(entry['policy'], `${label}.policy`, POLICIES)
  if (dataClass === 'authorized_api_data' && policy !== 'delete') {
    throw new RetentionConfigError(
      `${label} holds authorized API data and must use policy "delete": spec §12.4 allows "refresh 또는 delete", but this system has no path that re-fetches a past live-chat item, so "refresh" cannot be honoured`,
    )
  }

  if (policy === 'delete') {
    if (entry['reverifyPeriodDays'] !== undefined) {
      throw new RetentionConfigError(`${label}.reverifyPeriodDays is only for policy "refresh"`)
    }
    const allowedPeriodDays = readPositiveInt(
      entry['allowedPeriodDays'],
      `${label}.allowedPeriodDays`,
    )
    if (dataClass === 'authorized_api_data' && allowedPeriodDays > sourceDataRetentionDays) {
      throw new RetentionConfigError(
        `${label}.allowedPeriodDays ${String(allowedPeriodDays)} exceeds sourceDataRetentionDays ${String(sourceDataRetentionDays)} (spec §12.4)`,
      )
    }
    return Object.freeze({ ...common, policy: 'delete', allowedPeriodDays })
  }

  if (entry['allowedPeriodDays'] !== null) {
    throw new RetentionConfigError(
      `${label}.allowedPeriodDays must be null for policy "refresh": a refreshed field has no deletion deadline, it has a re-verification period`,
    )
  }
  return Object.freeze({
    ...common,
    policy: 'refresh',
    allowedPeriodDays: null,
    reverifyPeriodDays: readPositiveInt(
      entry['reverifyPeriodDays'],
      `${label}.reverifyPeriodDays`,
    ),
  })
}

function parseExpiry(value: unknown, label: string): RetentionExpiry {
  const entry = asObject(value, label)
  const kind = entry['kind']
  if (kind === 'column') {
    rejectUnknownKeys(entry, label, ['kind', 'column'])
    return Object.freeze({
      kind: 'column' as const,
      column: readIdentifier(entry['column'], `${label}.column`),
    })
  }
  if (kind === 'orphan') {
    rejectUnknownKeys(entry, label, ['kind', 'referencesTable'])
    return Object.freeze({
      kind: 'orphan' as const,
      referencesTable: readIdentifier(entry['referencesTable'], `${label}.referencesTable`),
    })
  }
  throw new RetentionConfigError(`${label}.kind must be "column" or "orphan"`)
}

function parseSchemaOnlyTable(value: unknown, label: string): SchemaOnlyTable {
  const entry = asObject(value, label)
  rejectUnknownKeys(entry, label, ['table', 'reason'])
  return Object.freeze({
    table: readIdentifier(entry['table'], `${label}.table`),
    reason: readString(entry['reason'], `${label}.reason`),
  })
}

/**
 * Every table of a live schema must be covered exactly once: by a retention
 * field or by an explicit `schemaOnlyTables` entry with a reason. Without this a
 * new table added by a later task would silently have no retention policy.
 */
export function assertSchemaCoverage(config: RetentionConfig, tables: readonly string[]): void {
  const covered = new Set<string>([
    ...config.fields.map((field) => field.table),
    ...config.schemaOnlyTables.map((entry) => entry.table),
  ])
  const uncovered = tables.filter((table) => !covered.has(table)).sort()
  if (uncovered.length > 0) {
    throw new RetentionConfigError(
      `these tables have no retention policy: ${uncovered.join(', ')}; add them to config/retention.json fields[] or schemaOnlyTables[] (spec §12.4)`,
    )
  }
  const present = new Set(tables)
  const missing = config.fields
    .filter((field) => field.status === 'present' && !present.has(field.table))
    .map((field) => field.table)
    .sort()
  if (missing.length > 0) {
    throw new RetentionConfigError(
      `config/retention.json declares ${missing.join(', ')} as present, but the schema has no such table`,
    )
  }
  const planned = config.fields
    .filter((field) => field.status === 'planned' && present.has(field.table))
    .map((field) => field.table)
    .sort()
  if (planned.length > 0) {
    throw new RetentionConfigError(
      `${planned.join(', ')} now exists; change its status from "planned" to "present" in config/retention.json`,
    )
  }
}

// ------------------------------------------------------------------ readers

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RetentionConfigError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * `$comment` keys are documentation and are ignored everywhere; anything else
 * outside the allowed set is rejected so a typo cannot be silently defaulted.
 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(record).filter(
    (key) => key !== '$comment' && !allowed.includes(key),
  )
  if (unknown.length > 0) {
    throw new RetentionConfigError(`${label} has unknown key(s): ${unknown.sort().join(', ')}`)
  }
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new RetentionConfigError(`${label} must be an array`)
  return value
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new RetentionConfigError(`${label} must be a non-empty string`)
  }
  return value
}

function readIdentifier(value: unknown, label: string): string {
  const text = readString(value, label)
  if (!SQL_IDENTIFIER.test(text)) {
    throw new RetentionConfigError(
      `${label} must be a lower-snake-case SQL identifier, got ${text}`,
    )
  }
  return text
}

function readStringArray(value: unknown, label: string): string[] {
  const array = readArray(value, label)
  return array.map((entry, index) => readString(entry, `${label}[${String(index)}]`))
}

function readPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RetentionConfigError(`${label} must be a positive integer`)
  }
  return value
}

function readEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const text = readString(value, label)
  if (!allowed.includes(text as T)) {
    throw new RetentionConfigError(`${label} must be one of ${allowed.join(', ')}, got ${text}`)
  }
  return text as T
}

function assertAtMost(value: number, max: number, label: string, rule: string): void {
  if (value > max) {
    throw new RetentionConfigError(
      `${label} ${String(value)} exceeds the ${String(max)}-day policy maximum (spec §12.4: "${rule}")`,
    )
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new RetentionConfigError(`${label} has a duplicate: ${value}`)
    seen.add(value)
  }
}
