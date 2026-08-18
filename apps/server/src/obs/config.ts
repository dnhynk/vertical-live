import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
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

/**
 * How the host launches OBS itself (T17). It is off by default because the
 * executable path is host-specific and because a deployment without it is a
 * legitimate one: spec §9.1 leaves 최초 공개 and the host setup with a person.
 * When it is off, the supervisor's `obs-process` escalation fails honestly
 * instead of pretending to have relaunched anything.
 */
export interface ObsProcessConfig {
  readonly enabled: boolean
  readonly executablePath: string
  /** OBS profile to start with (`--profile`, official launch parameter). */
  readonly profile: string
  /** OBS scene collection to start with (`--collection`). */
  readonly sceneCollection: string
  /**
   * Extra documented launch parameters. Only flags listed in
   * https://obsproject.com/kb/launch-parameters belong here; a flag that is not
   * in that list is either ignored or gone (`--disable-shutdown-check` was
   * removed in OBS 32.0.0), and an ops script must not depend on it.
   */
  readonly extraArgs: readonly string[]
  /**
   * OBS's crash-sentinel directory, emptied immediately before the spawn
   * (BOARD D-7). OBS writes a file here while it runs and removes it on a clean
   * exit; a file left behind is what makes the next start offer Safe Mode, and
   * Safe Mode disables obs-websocket — the whole control path
   * (https://github.com/obsproject/obs-studio/pull/8455, 확인 2026-08-18).
   *
   * Empty means "no sentinel directory on this host": `%APPDATA%` is a Windows
   * variable and this is a Windows-first host (BOARD D-2), so a host without it
   * (CI, a POSIX box) simply has nothing to clear. This is an observed path, not
   * a tuning number — it is not in `provisional`.
   */
  readonly sentinelDir: string
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
   * The renderer page that Browser Source opens, **without** the token. The
   * token is a vault secret (`server.rendererToken`, T8) that the server injects
   * at runtime with `SetInputSettings`, the same custody rule the stream key
   * follows (BOARD A-16). It is never in this file, and OBS's cached copy in the
   * scene-collection JSON is cleared on stop.
   */
  readonly browserSourceUrl: string
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
  readonly process: ObsProcessConfig
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
  const obsProcess = readObject(section['process'], 'obs.process')

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
    browserSourceUrl: assertTokenlessUrl(
      readString(section['browserSourceUrl'], 'obs.browserSourceUrl'),
    ),
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
    process: Object.freeze({
      enabled: readBoolean(
        env['VL_OBS_PROCESS_ENABLED'] ?? obsProcess['enabled'],
        'obs.process.enabled',
      ),
      executablePath: readString(
        env['VL_OBS_EXECUTABLE'] ?? obsProcess['executablePath'],
        'obs.process.executablePath',
      ),
      profile: readString(obsProcess['profile'], 'obs.process.profile'),
      sceneCollection: readString(obsProcess['sceneCollection'], 'obs.process.sceneCollection'),
      extraArgs: Object.freeze(readStringArray(obsProcess['extraArgs'], 'obs.process.extraArgs')),
      sentinelDir: resolveSentinelDir(obsProcess['sentinelDir'], env),
    }),
    provisional: Object.freeze(readStringArray(section['provisional'], 'obs.provisional')),
  })
}

/**
 * `VL_OBS_SENTINEL_DIR` → config value → `%APPDATA%\obs-studio\.sentinel` → none.
 *
 * The derived form is built with `win32.join` rather than the host's separator:
 * `APPDATA` only exists on Windows, so the value is a Windows path wherever this
 * code happens to run (the same lesson as T17b's executable paths).
 */
function resolveSentinelDir(configured: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof configured !== 'string') {
    throw new ObsConfigError(
      'obs.process.sentinelDir must be a string ("" derives it from APPDATA)',
    )
  }
  const override = env['VL_OBS_SENTINEL_DIR']
  if (override !== undefined && override !== '') return override
  if (configured !== '') return configured
  const appData = env['APPDATA']
  if (appData === undefined || appData === '') return ''
  return win32.join(appData, 'obs-studio', '.sentinel')
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

/**
 * The renderer page URL in config must not carry a token: the vault is the
 * token's system of record and the server injects it at runtime (spec §10.2,
 * BOARD A-16). A token here would be a secret in the repository.
 */
export function assertTokenlessUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ObsConfigError(`obs.browserSourceUrl is not a URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ObsConfigError(`obs.browserSourceUrl must be http(s), got ${parsed.protocol}`)
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new ObsConfigError(
      `obs.browserSourceUrl must be loopback (spec §10.2), got host ${parsed.hostname}`,
    )
  }
  if (parsed.searchParams.has('token')) {
    throw new ObsConfigError(
      'obs.browserSourceUrl must not contain a token; the vault is its system of record (BOARD A-16)',
    )
  }
  return url
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

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ObsConfigError(`${path} must be a boolean`)
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
