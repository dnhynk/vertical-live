import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * OBS connection/observation settings. Values live in `config/default.json`
 * with env overrides (shared convention, `docs/tasks/TASK_SPECS.md` 공통 규약).
 * Numbers the spec does not fix are listed in `provisional` and are replaced by
 * the Gate 0/2 approved values (BOARD A-15) — they are not pass/fail lines.
 */
export interface ObsReconnectConfig {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly factor: number
}

export interface ObsThresholdConfig {
  /** `GetStreamStatus.outputCongestion` at or above this reports degraded. */
  readonly congestionDegradedAt: number
  /** Skipped/total output frames per sample at or above this reports degraded. */
  readonly skippedFrameRatioDegradedAt: number
  /** Consecutive samples with no byte/duration progress before reporting degraded. */
  readonly stalledSamplesDegradedAt: number
}

export interface ObsConfig {
  readonly url: string
  readonly connectTimeoutMs: number
  readonly pollIntervalMs: number
  readonly commandVerifyTimeoutMs: number
  readonly commandVerifyIntervalMs: number
  /** Browser Source input that shows the renderer; target of `refreshnocache`. */
  readonly browserSourceName: string
  /**
   * RTMPS ingestion URL the server injects with the vault's stream key before
   * going live. The key itself never appears in config: the vault is its system
   * of record (spec §10.2, BOARD A-16), and it stays out of the repository, the
   * game DB, logs, and the screen. Once injected, OBS caches it in the active
   * profile's `service.json`; clearing that on stop is T17.
   */
  readonly streamIngestUrl: string
  readonly reconnect: ObsReconnectConfig
  readonly thresholds: ObsThresholdConfig
  /** Keys whose values are provisional (BOARD A-15). */
  readonly provisional: readonly string[]
}

/** `config/default.json` at the repository root, from `src/obs/` or `dist/obs/`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/default.json', import.meta.url),
)

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export class ObsConfigError extends Error {
  constructor(message: string) {
    super(`invalid obs config: ${message}`)
    this.name = 'ObsConfigError'
  }
}

export interface LoadObsConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
  /**
   * Escape hatch for a host that reaches OBS over an explicit firewall
   * allowlist instead of loopback (spec §10.2). Off by default.
   */
  readonly allowNonLoopback?: boolean
}

export function loadObsConfig(options: LoadObsConfigOptions = {}): ObsConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new ObsConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }

  const obs = readObject(parsed, 'root')['obs']
  if (obs === undefined) {
    throw new ObsConfigError(`missing "obs" section in ${configPath}`)
  }
  const section = readObject(obs, 'obs')
  const reconnect = readObject(section['reconnect'], 'obs.reconnect')
  const thresholds = readObject(section['thresholds'], 'obs.thresholds')

  const url = env['VL_OBS_URL'] ?? readString(section['url'], 'obs.url')
  assertWebSocketUrl(url, options.allowNonLoopback === true)

  return Object.freeze({
    url,
    connectTimeoutMs: readPositiveInt(section['connectTimeoutMs'], 'obs.connectTimeoutMs'),
    pollIntervalMs: readPositiveInt(section['pollIntervalMs'], 'obs.pollIntervalMs'),
    commandVerifyTimeoutMs: readPositiveInt(
      section['commandVerifyTimeoutMs'],
      'obs.commandVerifyTimeoutMs',
    ),
    commandVerifyIntervalMs: readPositiveInt(
      section['commandVerifyIntervalMs'],
      'obs.commandVerifyIntervalMs',
    ),
    browserSourceName: readString(section['browserSourceName'], 'obs.browserSourceName'),
    streamIngestUrl: readString(section['streamIngestUrl'], 'obs.streamIngestUrl'),
    reconnect: Object.freeze({
      initialDelayMs: readPositiveInt(reconnect['initialDelayMs'], 'obs.reconnect.initialDelayMs'),
      maxDelayMs: readPositiveInt(reconnect['maxDelayMs'], 'obs.reconnect.maxDelayMs'),
      factor: readPositiveNumber(reconnect['factor'], 'obs.reconnect.factor'),
    }),
    thresholds: Object.freeze({
      congestionDegradedAt: readPositiveNumber(
        thresholds['congestionDegradedAt'],
        'obs.thresholds.congestionDegradedAt',
      ),
      skippedFrameRatioDegradedAt: readPositiveNumber(
        thresholds['skippedFrameRatioDegradedAt'],
        'obs.thresholds.skippedFrameRatioDegradedAt',
      ),
      stalledSamplesDegradedAt: readPositiveInt(
        thresholds['stalledSamplesDegradedAt'],
        'obs.thresholds.stalledSamplesDegradedAt',
      ),
    }),
    provisional: Object.freeze(readStringArray(section['provisional'], 'obs.provisional')),
  })
}

/** obs-websocket must stay on loopback unless the operator opted out (spec §10.2). */
export function assertWebSocketUrl(url: string, allowNonLoopback: boolean): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ObsConfigError(`obs.url is not a URL: ${url}`)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new ObsConfigError(`obs.url must be ws:// or wss://, got ${parsed.protocol}`)
  }
  if (!allowNonLoopback && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new ObsConfigError(
      `obs.url must be loopback (spec §10.2), got host ${parsed.hostname}. ` +
        'Pass allowNonLoopback only for an explicit firewall allowlist.',
    )
  }
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ObsConfigError(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ObsConfigError(`${path} must be a non-empty string`)
  }
  return value
}

function readPositiveNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ObsConfigError(`${path} must be a positive number`)
  }
  return value
}

function readPositiveInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ObsConfigError(`${path} must be a positive integer`)
  }
  return value
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ObsConfigError(`${path} must be an array of strings`)
  }
  return [...(value as string[])]
}
