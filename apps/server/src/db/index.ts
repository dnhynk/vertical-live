/**
 * The authoritative SQL persistence layer (spec §10.2). `PersistenceStore` is
 * the only writer interface; T8 (state engine), T9 (source adapter), T10
 * (broadcast) and T13 (retention) use it instead of touching SQL directly.
 */
export {
  DB_BUSY_TIMEOUT_ENV,
  DB_FILE_ENV,
  DatabaseConfigError,
  loadDatabaseConfig,
  type DatabaseConfig,
  type LoadDatabaseConfigOptions,
} from './config.js'
export {
  DatabaseOpenError,
  REQUIRED_PRAGMAS,
  openDatabase,
  readPragma,
  type OpenDatabaseOptions,
} from './open.js'
export {
  EffectNotPublishedError,
  PersistenceInvariantError,
  StateRevisionError,
  UnknownEffectError,
  classifySqliteError,
  isLockContention,
  sqliteErrorCode,
  type SqliteFailure,
  type SqliteFailureKind,
} from './errors.js'
export {
  MIGRATIONS_DIR,
  MigrationError,
  listAppliedMigrations,
  loadMigrations,
  migrate,
  type AppliedMigration,
  type Migration,
  type MigrateOptions,
  type MigrateResult,
} from './migrate.js'
export { DEFAULT_WORLD_ID, PersistenceStore, type OpenStoreOptions } from './store.js'
export type * from './types.js'
