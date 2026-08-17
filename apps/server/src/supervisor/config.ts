import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { HEALTH_FAMILIES, SUPERVISED_COMPONENTS } from './types.js'
import type { HealthFamily, SupervisedComponent } from './types.js'

/**
 * Supervisor settings from `config/default.json` with env overrides (TASK_SPECS
 * 공통 규약).
 *
 * Every threshold here is **provisional** (BOARD A-15). Spec §11 fixes the
 * *shape* of the reliability bar — maximum outage, recovery time, freeze
 * allowance, alert delivery time — and leaves the numbers to Gate 0/2, so
 * nothing in this file is a pass line. They exist so the state machine has a
 * value to compare against instead of an invented literal in the code.
 */

export interface SupervisorRendererConfig {
  /** Below this the renderer family reports `degraded` (spec §9.4(4)). */
  readonly minFps: number
  /** A renderer report older than this makes the family unobservable. */
  readonly reportStaleAfterMs: number
}

export interface SupervisorRestartConfig {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly factor: number
  readonly jitterRatio: number
  /** Attempts per component before `safe_stopped` / escalation (spec §9.2). */
  readonly maxAttempts: Readonly<Record<SupervisedComponent, number>>
}

export interface SupervisorStartupConfig {
  /**
   * Attempts at the whole §7.3(3) start-up sequence before `safe_stopped`.
   * A host that boots faster than OBS or than its network is the ordinary case
   * this exists for (spec §9.1 자동 복구); a sequence that keeps failing is the
   * "최대 재시도 후 safe_stopped" case of §9.2.
   */
  readonly maxAttempts: number
}

/** Integrations this deployment actually has (spec §9.1 자동화 경계). */
export interface SupervisorIntegrationConfig {
  /** OBS websocket: connection, stream service injection, output control. */
  readonly obs: boolean
  /** YouTube broadcast lifecycle (T10). Needs an OAuth grant and a channel. */
  readonly broadcast: boolean
}

export interface SupervisorAlertConfig {
  /** Per-severity duplicate-suppression window, keyed by `kind:reason`. */
  readonly suppressWindowMs: {
    readonly info: number
    readonly warning: number
    readonly critical: number
  }
  readonly deliveryTimeoutMs: number
  /** Discord webhook sink (BOARD D-3). The URL itself lives in the vault. */
  readonly discordEnabled: boolean
}

export interface DeadManConfig {
  /** Off until an operator provisions the push URL in the vault ([S23]). */
  readonly enabled: boolean
  readonly intervalMs: number
  readonly requestTimeoutMs: number
}

export interface KillSwitchConfig {
  /** Local flag file; its presence stops the run (spec §11 안전 정지). */
  readonly flagFile: string
  readonly pollIntervalMs: number
}

export interface ScreenshotConfig {
  /** Diagnostics only. Never an input to a freeze verdict (spec §9.4). */
  readonly enabled: boolean
  readonly intervalMs: number
  readonly directory: string
  /** Files kept before the oldest is deleted (rolling archive, spec §9.1). */
  readonly keep: number
  readonly sourceName: string
  readonly imageFormat: string
  readonly imageWidth: number
}

/**
 * Spec §12.3 / Gate 0: "24시간 호출 책임자, 최대 응답시간, escalation 채널, 자동
 * 차단 범위와 safe-stop 조건을 승인한다. 이 운영표가 없으면 Gate 3 public
 * 파일럿을 시작하지 않는다."
 *
 * TASK_SPECS §T12 asks T12 for the *place*, not the values: they are a human
 * approval, so the fields stay empty and `approved` stays false until Gate 0.
 * `assertModerationCallTableApproved` is the gate T16/Gate 3 can call.
 */
export interface ModerationCallTableConfig {
  readonly approved: boolean
  readonly onCallOwner: string | null
  readonly maxResponseMinutes: number | null
  readonly escalationChannel: string | null
  readonly autoBlockScope: string | null
  readonly safeStopConditions: readonly string[]
}

export interface SupervisorConfig {
  readonly evaluateIntervalMs: number
  /** No supervisor evaluation within this window ⇒ coordinator degraded (§9.4(1)). */
  readonly coordinatorHeartbeatTimeoutMs: number
  /** No committed state transition within this window ⇒ degraded (§9.4(2)). */
  readonly stateCommitStaleAfterMs: number
  /** A pushed signal older than this stops counting as an observation. */
  readonly signalStaleAfterMs: number
  /** How long a required family may stay unobservable before it is degraded. */
  readonly unobservableGraceMs: number
  /** Families whose absence is itself a fault (see `unobservableGraceMs`). */
  readonly requiredFamilies: readonly HealthFamily[]
  readonly renderer: SupervisorRendererConfig
  readonly startup: SupervisorStartupConfig
  readonly integrations: SupervisorIntegrationConfig
  readonly restart: SupervisorRestartConfig
  readonly alerts: SupervisorAlertConfig
  readonly deadMan: DeadManConfig
  readonly killSwitch: KillSwitchConfig
  readonly screenshot: ScreenshotConfig
  readonly moderation: ModerationCallTableConfig
  readonly provisional: readonly string[]
}

/** `config/default.json` at the repository root, from `src/` or `dist/`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/default.json', import.meta.url),
)

export class SupervisorConfigError extends Error {
  constructor(message: string) {
    super(`invalid supervisor config: ${message}`)
    this.name = 'SupervisorConfigError'
  }
}

export interface LoadSupervisorConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadSupervisorConfig(
  options: LoadSupervisorConfigOptions = {},
): SupervisorConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new SupervisorConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }

  const root = readObject(parsed, 'root')
  const section = readObject(root['supervisor'], 'supervisor')
  const renderer = readObject(section['renderer'], 'supervisor.renderer')
  const startup = readObject(section['startup'], 'supervisor.startup')
  const integrations = readObject(section['integrations'], 'supervisor.integrations')
  const restart = readObject(section['restart'], 'supervisor.restart')
  const maxAttempts = readObject(restart['maxAttempts'], 'supervisor.restart.maxAttempts')
  const alerts = readObject(section['alerts'], 'supervisor.alerts')
  const suppress = readObject(alerts['suppressWindowMs'], 'supervisor.alerts.suppressWindowMs')
  const deadMan = readObject(section['deadMan'], 'supervisor.deadMan')
  const killSwitch = readObject(section['killSwitch'], 'supervisor.killSwitch')
  const screenshot = readObject(section['screenshot'], 'supervisor.screenshot')
  const moderation = readObject(section['moderation'], 'supervisor.moderation')

  return Object.freeze({
    evaluateIntervalMs: readPositiveInt(
      env['VL_SUPERVISOR_INTERVAL_MS'] ?? section['evaluateIntervalMs'],
      'supervisor.evaluateIntervalMs',
    ),
    coordinatorHeartbeatTimeoutMs: readPositiveInt(
      section['coordinatorHeartbeatTimeoutMs'],
      'supervisor.coordinatorHeartbeatTimeoutMs',
    ),
    stateCommitStaleAfterMs: readPositiveInt(
      section['stateCommitStaleAfterMs'],
      'supervisor.stateCommitStaleAfterMs',
    ),
    signalStaleAfterMs: readPositiveInt(
      section['signalStaleAfterMs'],
      'supervisor.signalStaleAfterMs',
    ),
    unobservableGraceMs: readNonNegativeInt(
      section['unobservableGraceMs'],
      'supervisor.unobservableGraceMs',
    ),
    requiredFamilies: Object.freeze(
      readFamilies(section['requiredFamilies'], 'supervisor.requiredFamilies'),
    ),
    renderer: Object.freeze({
      minFps: readPositiveNumber(renderer['minFps'], 'supervisor.renderer.minFps'),
      reportStaleAfterMs: readPositiveInt(
        renderer['reportStaleAfterMs'],
        'supervisor.renderer.reportStaleAfterMs',
      ),
    }),
    startup: Object.freeze({
      maxAttempts: readPositiveInt(startup['maxAttempts'], 'supervisor.startup.maxAttempts'),
    }),
    integrations: Object.freeze({
      obs: readBoolean(env['VL_OBS_ENABLED'] ?? integrations['obs'], 'supervisor.integrations.obs'),
      broadcast: readBoolean(
        env['VL_BROADCAST_ENABLED'] ?? integrations['broadcast'],
        'supervisor.integrations.broadcast',
      ),
    }),
    restart: Object.freeze({
      initialDelayMs: readPositiveInt(
        restart['initialDelayMs'],
        'supervisor.restart.initialDelayMs',
      ),
      maxDelayMs: readPositiveInt(restart['maxDelayMs'], 'supervisor.restart.maxDelayMs'),
      factor: readPositiveNumber(restart['factor'], 'supervisor.restart.factor'),
      jitterRatio: readRatio(restart['jitterRatio'], 'supervisor.restart.jitterRatio'),
      maxAttempts: Object.freeze(
        readComponentAttempts(maxAttempts, 'supervisor.restart.maxAttempts'),
      ),
    }),
    alerts: Object.freeze({
      suppressWindowMs: Object.freeze({
        info: readNonNegativeInt(suppress['info'], 'supervisor.alerts.suppressWindowMs.info'),
        warning: readNonNegativeInt(
          suppress['warning'],
          'supervisor.alerts.suppressWindowMs.warning',
        ),
        critical: readNonNegativeInt(
          suppress['critical'],
          'supervisor.alerts.suppressWindowMs.critical',
        ),
      }),
      deliveryTimeoutMs: readPositiveInt(
        alerts['deliveryTimeoutMs'],
        'supervisor.alerts.deliveryTimeoutMs',
      ),
      discordEnabled: readBoolean(
        env['VL_ALERTS_DISCORD_ENABLED'] ?? alerts['discordEnabled'],
        'supervisor.alerts.discordEnabled',
      ),
    }),
    deadMan: Object.freeze({
      enabled: readBoolean(
        env['VL_DEAD_MAN_ENABLED'] ?? deadMan['enabled'],
        'supervisor.deadMan.enabled',
      ),
      intervalMs: readPositiveInt(deadMan['intervalMs'], 'supervisor.deadMan.intervalMs'),
      requestTimeoutMs: readPositiveInt(
        deadMan['requestTimeoutMs'],
        'supervisor.deadMan.requestTimeoutMs',
      ),
    }),
    killSwitch: Object.freeze({
      flagFile: readNonEmptyString(
        env['VL_KILL_SWITCH_FILE'] ?? killSwitch['flagFile'],
        'supervisor.killSwitch.flagFile',
      ),
      pollIntervalMs: readPositiveInt(
        killSwitch['pollIntervalMs'],
        'supervisor.killSwitch.pollIntervalMs',
      ),
    }),
    screenshot: Object.freeze({
      enabled: readBoolean(
        env['VL_SCREENSHOT_ENABLED'] ?? screenshot['enabled'],
        'supervisor.screenshot.enabled',
      ),
      intervalMs: readPositiveInt(screenshot['intervalMs'], 'supervisor.screenshot.intervalMs'),
      directory: readNonEmptyString(screenshot['directory'], 'supervisor.screenshot.directory'),
      keep: readPositiveInt(screenshot['keep'], 'supervisor.screenshot.keep'),
      sourceName: readNonEmptyString(screenshot['sourceName'], 'supervisor.screenshot.sourceName'),
      imageFormat: readNonEmptyString(
        screenshot['imageFormat'],
        'supervisor.screenshot.imageFormat',
      ),
      imageWidth: readPositiveInt(screenshot['imageWidth'], 'supervisor.screenshot.imageWidth'),
    }),
    moderation: Object.freeze({
      approved: readBoolean(moderation['approved'], 'supervisor.moderation.approved'),
      onCallOwner: readNullableString(
        moderation['onCallOwner'],
        'supervisor.moderation.onCallOwner',
      ),
      maxResponseMinutes: readNullableInt(
        moderation['maxResponseMinutes'],
        'supervisor.moderation.maxResponseMinutes',
      ),
      escalationChannel: readNullableString(
        moderation['escalationChannel'],
        'supervisor.moderation.escalationChannel',
      ),
      autoBlockScope: readNullableString(
        moderation['autoBlockScope'],
        'supervisor.moderation.autoBlockScope',
      ),
      safeStopConditions: Object.freeze(
        readStringArray(
          moderation['safeStopConditions'],
          'supervisor.moderation.safeStopConditions',
        ),
      ),
    }),
    provisional: Object.freeze(readStringArray(section['provisional'], 'supervisor.provisional')),
  })
}

/** Thrown by `assertModerationCallTableApproved` while Gate 0 has not signed off. */
export class ModerationCallTableNotApprovedError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `moderation call table not approved (spec §12.3, Gate 0); missing: ${missing.join(', ')}`,
    )
    this.name = 'ModerationCallTableNotApprovedError'
  }
}

/**
 * Gate 3's precondition, callable from an ops check: spec §12.3 forbids starting
 * the public pilot without the approved call table. Nothing in the supervisor
 * fills these values in — an unapproved table stays unapproved.
 */
export function assertModerationCallTableApproved(config: ModerationCallTableConfig): void {
  const missing: string[] = []
  if (!config.approved) missing.push('approved')
  if (config.onCallOwner === null) missing.push('onCallOwner')
  if (config.maxResponseMinutes === null) missing.push('maxResponseMinutes')
  if (config.escalationChannel === null) missing.push('escalationChannel')
  if (config.autoBlockScope === null) missing.push('autoBlockScope')
  if (config.safeStopConditions.length === 0) missing.push('safeStopConditions')
  if (missing.length > 0) throw new ModerationCallTableNotApprovedError(missing)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new SupervisorConfigError(`${path} must be an object`)
  }
  return value
}

function readInt(value: unknown, path: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new SupervisorConfigError(`${path} must be an integer`)
  }
  return parsed
}

function readPositiveInt(value: unknown, path: string): number {
  const parsed = readInt(value, path)
  if (parsed <= 0) throw new SupervisorConfigError(`${path} must be greater than 0`)
  return parsed
}

function readNonNegativeInt(value: unknown, path: string): number {
  const parsed = readInt(value, path)
  if (parsed < 0) throw new SupervisorConfigError(`${path} must not be negative`)
  return parsed
}

function readPositiveNumber(value: unknown, path: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
    throw new SupervisorConfigError(`${path} must be a number greater than 0`)
  }
  return parsed
}

function readRatio(value: unknown, path: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new SupervisorConfigError(`${path} must be between 0 and 1`)
  }
  return parsed
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SupervisorConfigError(`${path} must be a non-empty string`)
  }
  return value
}

function readNullableString(value: unknown, path: string): string | null {
  if (value === null) return null
  return readNonEmptyString(value, path)
}

function readNullableInt(value: unknown, path: string): number | null {
  if (value === null) return null
  return readPositiveInt(value, path)
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new SupervisorConfigError(`${path} must be a boolean`)
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SupervisorConfigError(`${path} must be an array of strings`)
  }
  return [...(value as string[])]
}

function readFamilies(value: unknown, path: string): HealthFamily[] {
  const names = readStringArray(value, path)
  const known = new Set<string>(HEALTH_FAMILIES)
  for (const name of names) {
    if (!known.has(name)) {
      throw new SupervisorConfigError(`${path} contains unknown health family ${name}`)
    }
  }
  return names as HealthFamily[]
}

/**
 * Every supervised component must have an attempt budget: a component that
 * silently defaulted to "unlimited" would never reach `safe_stopped`, which is
 * the one outcome spec §9.2 requires after the retries run out.
 */
function readComponentAttempts(
  value: Record<string, unknown>,
  path: string,
): Record<SupervisedComponent, number> {
  const attempts = {} as Record<SupervisedComponent, number>
  for (const component of SUPERVISED_COMPONENTS) {
    attempts[component] = readPositiveInt(value[component], `${path}.${component}`)
  }
  for (const key of Object.keys(value)) {
    if (!(SUPERVISED_COMPONENTS as readonly string[]).includes(key)) {
      throw new SupervisorConfigError(`${path}.${key} is not a supervised component`)
    }
  }
  return attempts
}
