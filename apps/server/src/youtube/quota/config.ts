import {
  AuthConfigError,
  asObject,
  readPositiveInt,
  readString,
  readStringArray,
  readYouTubeSection,
  type LoadAuthConfigOptions,
} from '../auth/config.js'

/**
 * `youtube.quota` from `config/default.json`. Only `dailyUnits` and the reset
 * time zone are documented facts (see `costs.ts`); the reserve and the backoff
 * numbers are provisional (BOARD A-15) until Gate 2 measures real usage.
 */

export interface QuotaBackoffConfig {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly factor: number
  readonly jitterRatio: number
  readonly maxAttempts: number
}

export interface QuotaConfig {
  readonly dailyUnits: number
  readonly resetTimeZone: string
  readonly reserveUnits: number
  readonly backoff: QuotaBackoffConfig
  readonly provisional: readonly string[]
}

export function loadQuotaConfig(options: LoadAuthConfigOptions = {}): QuotaConfig {
  const section = readYouTubeSection('quota', options)
  const backoff = asObject(section['backoff'], 'youtube.quota.backoff')

  const dailyUnits = readPositiveInt(section['dailyUnits'], 'youtube.quota.dailyUnits')
  const reserveUnits = readNonNegativeInt(section['reserveUnits'], 'youtube.quota.reserveUnits')
  if (reserveUnits >= dailyUnits) {
    throw new AuthConfigError('youtube.quota.reserveUnits must be smaller than dailyUnits')
  }

  return Object.freeze({
    dailyUnits,
    resetTimeZone: readString(section['resetTimeZone'], 'youtube.quota.resetTimeZone'),
    reserveUnits,
    backoff: Object.freeze({
      initialDelayMs: readPositiveInt(
        backoff['initialDelayMs'],
        'youtube.quota.backoff.initialDelayMs',
      ),
      maxDelayMs: readPositiveInt(backoff['maxDelayMs'], 'youtube.quota.backoff.maxDelayMs'),
      factor: readPositiveNumber(backoff['factor'], 'youtube.quota.backoff.factor'),
      jitterRatio: readRatio(backoff['jitterRatio'], 'youtube.quota.backoff.jitterRatio'),
      maxAttempts: readPositiveInt(backoff['maxAttempts'], 'youtube.quota.backoff.maxAttempts'),
    }),
    provisional: Object.freeze(
      readStringArray(section['provisional'], 'youtube.quota.provisional'),
    ),
  })
}

function readNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AuthConfigError(`${label} must be a non-negative integer`)
  }
  return value
}

function readPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AuthConfigError(`${label} must be a positive number`)
  }
  return value
}

function readRatio(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AuthConfigError(`${label} must be between 0 and 1`)
  }
  return value
}
