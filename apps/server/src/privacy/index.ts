/**
 * Data retention, deletion and consent-revocation automation (spec §12.4, §14.1).
 *
 * `config/retention.json` is the authority for what is stored, why, for how long
 * and under which policy; `docs/ops/data-map.md` is generated from it. Everything
 * that deletes goes through `PersistenceStore` and writes an append-only
 * `retention_ledger` row, so every obligation is provable after the fact.
 */
export {
  AUTH_REVOKED_REASONS,
  CONSENT_FIELD_KEY,
  DEFAULT_RETENTION_CONFIG_PATH,
  POLICY_MAX_CLIENT_SIDE_DELETION_DAYS,
  POLICY_MAX_CONSENT_IDENTITY_DAYS,
  POLICY_MAX_PROVIDER_SIDE_DELETION_DAYS,
  POLICY_MAX_SOURCE_DATA_DAYS,
  POLICY_MAX_USER_REQUEST_DELETION_DAYS,
  RETENTION_CONFIG_ENV,
  RetentionConfigError,
  assertSchemaCoverage,
  loadRetentionConfig,
  parseRetentionConfig,
  type LiveSchema,
  type LoadRetentionConfigOptions,
  type RetentionConfig,
  type RetentionDataClass,
  type RetentionDeleteField,
  type RetentionExpiry,
  type RetentionField,
  type RetentionFieldStatus,
  type RetentionPersonalIdentifiers,
  type RetentionRefreshField,
  type RetentionSweepConfig,
  type RevocationClass,
  type RevocationConfig,
  type SchemaOnlyTable,
} from './config.js'
export {
  APPROVAL_GATED_METRICS,
  FORBIDDEN_METRIC_TOKENS,
  findForbiddenMetricTokens,
  normalizeForMetricScan,
  type ApprovalGatedMetric,
  type MetricGate,
  type MetricTokenHit,
} from './derived-metrics.js'
export {
  IdentityColumnsPresentError,
  USER_DELETION_FIELD_KEY,
  UserDeletionRequestHandler,
  type UserDeletionReceipt,
  type UserDeletionRequestOptions,
  type UserDeletionSubject,
} from './deletion-request.js'
export {
  CONSENT_SCHEMA_OBJECTS,
  CONSENT_TABLE,
  IDENTITY_NAME_PARTS,
  findConsentIdentityColumns,
  findIdentityColumns,
  findIdentitySchemaText,
  matchIdentityPart,
  stripSqlComments,
  type IdentityColumnHit,
  type IdentitySchemaTextHit,
} from './identity-columns.js'
export {
  RetentionLedgerUnavailableError,
  RetentionSweeper,
  allowedPeriodDaysOf,
  minusDays,
  plusDays,
  type RetentionEntryResult,
  type RetentionSweepResult,
  type RetentionSweeperOptions,
  type Reverifier,
  type ReverifyVerdict,
} from './retention.js'
export {
  RevocationAuthEventSink,
  RevocationHandler,
  vaultGrantRevoker,
  type GrantRevokeOutcome,
  type GrantRevoker,
  type RevocationAuthEventSinkOptions,
  type RevocationEntryResult,
  type RevocationFailure,
  type RevocationHandlerOptions,
  type RevocationResult,
} from './revocation.js'
export {
  RetentionScheduler,
  type RetentionSchedulerOptions,
  type RetentionSweepFailure,
} from './scheduler.js'
