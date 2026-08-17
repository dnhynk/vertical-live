import { readFileSync } from 'node:fs'

import { SOURCE_DATA_RETENTION_DAYS } from '@vl/contract'
import { describe, expect, it } from 'vitest'

import {
  AUTH_REVOKED_REASONS,
  DEFAULT_RETENTION_CONFIG_PATH,
  POLICY_MAX_CLIENT_SIDE_DELETION_DAYS,
  POLICY_MAX_PROVIDER_SIDE_DELETION_DAYS,
  RETENTION_CONFIG_ENV,
  RetentionConfigError,
  loadRetentionConfig,
  parseRetentionConfig,
} from './config.js'

/**
 * `config/retention.json` is the authority for the §12.4 schedule, so both halves
 * are tested: the shipped file says what the spec requires, and a file that says
 * anything weaker is rejected rather than silently accepted.
 */

const SHIPPED = JSON.parse(readFileSync(DEFAULT_RETENTION_CONFIG_PATH, 'utf8')) as Record<
  string,
  unknown
>

function withRoot(overrides: Record<string, unknown>): unknown {
  return { ...structuredClone(SHIPPED), ...overrides }
}

/** The shipped document with one field entry replaced by a patched copy. */
function withField(key: string, patch: Record<string, unknown>): unknown {
  const document = structuredClone(SHIPPED) as { fields: Record<string, unknown>[] }
  const index = document.fields.findIndex((field) => field['key'] === key)
  expect(index).toBeGreaterThanOrEqual(0)
  document.fields[index] = { ...document.fields[index], ...patch }
  return document
}

describe('the shipped retention config', () => {
  const config = loadRetentionConfig()

  it('loads and covers the whole §12.4 schedule', () => {
    expect(config.version).toBe(1)
    expect(config.sourceDataRetentionDays).toBe(30)
    expect(config.fields.length).toBeGreaterThan(5)
    expect(config.schemaOnlyTables.length).toBeGreaterThan(0)
  })

  it('agrees with the contract constant for source-data retention (BOARD A-7)', () => {
    // `sourceDataExpiresAt = receivedAt + 30일` is computed in @vl/contract; if the
    // two drifted, envelopes would advertise a deadline the sweeper does not keep.
    expect(config.sourceDataRetentionDays).toBe(SOURCE_DATA_RETENTION_DAYS)
    const inbox = config.fields.find((field) => field.key === 'ingest_inbox.envelope')
    expect(inbox?.policy).toBe('delete')
    expect(inbox?.allowedPeriodDays).toBe(SOURCE_DATA_RETENTION_DAYS)
  })

  it('declares no personal identifier anywhere', () => {
    for (const field of config.fields) {
      expect(field.personalIdentifiers).toBe('none')
    }
  })

  it('deletes every authorized API field within the policy ceiling', () => {
    const authorized = config.fields.filter((field) => field.dataClass === 'authorized_api_data')
    expect(authorized.length).toBeGreaterThan(0)
    for (const field of authorized) {
      expect(field.policy).toBe('delete')
      expect(field.allowedPeriodDays).toBeLessThanOrEqual(config.sourceDataRetentionDays)
    }
  })

  it('uses the §12.4 windows for the two revocation branches', () => {
    expect(config.revocation.clientSideDeletionDays).toBe(POLICY_MAX_CLIENT_SIDE_DELETION_DAYS)
    expect(config.revocation.providerSideDeletionDays).toBe(POLICY_MAX_PROVIDER_SIDE_DELETION_DAYS)
    expect(config.revocation.userRequestDeletionDays).toBe(POLICY_MAX_CLIENT_SIDE_DELETION_DAYS)
    expect(config.revocation.reasonClass).toEqual({
      operator_revoked: 'client_side',
      invalid_grant: 'provider_side',
      missing_refresh_token: 'client_side',
    })
    for (const reason of AUTH_REVOKED_REASONS) {
      expect(config.revocation.reasonClass[reason]).toBeDefined()
    }
  })

  it('labels every unproven operational number as provisional (BOARD A-15)', () => {
    expect([...config.sweep.provisional].sort()).toEqual([
      'batchLimit',
      'intervalMs',
      'maxBatchesPerEntry',
    ])
  })

  it('gives every field a purpose and a spec reference', () => {
    for (const field of config.fields) {
      expect(field.purpose.length).toBeGreaterThan(20)
      expect(field.specRef).toMatch(/§/)
    }
    for (const entry of config.schemaOnlyTables) {
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })

  it('is read from the path in VL_RETENTION_CONFIG when it is set', () => {
    expect(() =>
      loadRetentionConfig({ env: { [RETENTION_CONFIG_ENV]: 'no/such/retention.json' } }),
    ).toThrow(RetentionConfigError)
  })
})

describe('rejected configs', () => {
  it('refuses a source-data window longer than the policy maximum', () => {
    expect(() => parseRetentionConfig(withRoot({ sourceDataRetentionDays: 31 }))).toThrow(
      /exceeds the 30-day policy maximum/,
    )
  })

  it('refuses a client-side deletion window longer than 7 days', () => {
    const document = structuredClone(SHIPPED) as { revocation: Record<string, unknown> }
    document.revocation = { ...document.revocation, clientSideDeletionDays: 8 }
    expect(() => parseRetentionConfig(document)).toThrow(/clientSideDeletionDays 8 exceeds/)
  })

  it('refuses a field that claims to store a personal identifier', () => {
    expect(() =>
      parseRetentionConfig(withField('ingest_inbox.envelope', { personalIdentifiers: 'declared' })),
    ).toThrow(/personalIdentifiers must be "none"/)
  })

  it('refuses authorized API data with a refresh policy', () => {
    expect(() =>
      parseRetentionConfig(
        withField('paid_ledger.event_key', {
          policy: 'refresh',
          allowedPeriodDays: null,
          reverifyPeriodDays: 30,
        }),
      ),
    ).toThrow(/must use policy "delete"/)
  })

  it('refuses an authorized field kept longer than sourceDataRetentionDays', () => {
    expect(() =>
      parseRetentionConfig(withField('paid_ledger.event_key', { allowedPeriodDays: 60 })),
    ).toThrow(/exceeds sourceDataRetentionDays/)
  })

  it('refuses a refresh field that carries a deletion period', () => {
    expect(() =>
      parseRetentionConfig(withField('world_snapshot.snapshot', { allowedPeriodDays: 30 })),
    ).toThrow(/must be null for policy "refresh"/)
  })

  it('refuses an unknown key so a typo cannot fall back to a default', () => {
    expect(() =>
      parseRetentionConfig(withField('ingest_inbox.envelope', { allowedPeriodDay: 30 })),
    ).toThrow(/unknown key\(s\): allowedPeriodDay/)
    expect(() => parseRetentionConfig(withRoot({ extra: true }))).toThrow(/unknown key/)
  })

  it('refuses a table name that is not a plain SQL identifier', () => {
    expect(() =>
      parseRetentionConfig(
        withField('ingest_inbox.envelope', { table: 'ingest_inbox; DROP TABLE' }),
      ),
    ).toThrow(/lower-snake-case SQL identifier/)
  })

  it('refuses a planned field with no owning task', () => {
    const document = structuredClone(SHIPPED) as { fields: Record<string, unknown>[] }
    const index = document.fields.findIndex((field) => field['key'] === 'metrics_daily.aggregates')
    const patched = { ...document.fields[index] }
    delete patched['plannedBy']
    document.fields[index] = patched
    expect(() => parseRetentionConfig(document)).toThrow(/plannedBy must name the task/)
  })

  it('refuses a duplicate field key or table', () => {
    const document = structuredClone(SHIPPED) as { fields: Record<string, unknown>[] }
    document.fields.push({ ...document.fields[0] })
    expect(() => parseRetentionConfig(document)).toThrow(/duplicate/)
  })

  it('refuses a table that is both a retention field and schema-only', () => {
    const document = structuredClone(SHIPPED) as {
      schemaOnlyTables: Record<string, unknown>[]
    }
    document.schemaOnlyTables.push({
      table: 'ingest_inbox',
      reason: 'a long enough reason string to pass the length check',
    })
    expect(() => parseRetentionConfig(document)).toThrow(/both as a retention field/)
  })

  it('refuses a provisional name that is not a sweep setting', () => {
    const document = structuredClone(SHIPPED) as { sweep: Record<string, unknown> }
    document.sweep = { ...document.sweep, provisional: ['nonsense'] }
    expect(() => parseRetentionConfig(document)).toThrow(/not a sweep setting/)
  })

  it('refuses an unclassified revocation reason', () => {
    const document = structuredClone(SHIPPED) as {
      revocation: { reasonClass: Record<string, unknown> }
    }
    document.revocation.reasonClass = { ...document.revocation.reasonClass, invalid_grant: 'later' }
    expect(() => parseRetentionConfig(document)).toThrow(/reasonClass.invalid_grant must be one of/)
  })

  it('refuses an unsupported version', () => {
    expect(() => parseRetentionConfig(withRoot({ version: 2 }))).toThrow(/unsupported version 2/)
  })
})
