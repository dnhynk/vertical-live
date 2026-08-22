import type { Clock } from '../clock.js'
import type { HealthDetailValue } from '../health/types.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { SupervisorAlertConfig } from './config.js'

/**
 * The human-callable path of spec §9.1 and §12.3 ("사람 알림", "사람 호출").
 *
 * `AlertSink` is the interface; the Slack incoming webhook is the channel in use
 * (BOARD D-3, amended 2026-08-22) and the Discord webhook stays available behind
 * its own config flag. Three rules hold for every implementation:
 *
 * 1. **Delivery never throws into the supervisor.** An alert transport that
 *    failed must not also take down the run it was reporting on, so every sink
 *    returns a result and logs the failure (TASK_SPECS §T12: "전달 실패 로그").
 * 2. **Nothing secret or personal leaves the process.** Alerts carry machine
 *    tokens and numbers the supervisor produced. No chat text, no author name,
 *    no channel id (§12.3, §12.4, BOARD A-1), no credential (§10.2).
 * 3. **Repeats are suppressed by severity**, so a stuck condition alerts once per
 *    window instead of once per evaluation.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface Alert {
  /** Machine-stable event name, e.g. `supervisor.safe_stopped`. */
  readonly kind: string
  readonly severity: AlertSeverity
  /** Absolute UTC ISO 8601 instant (spec §10.2). */
  readonly at: string
  /** Machine-stable reason token; never free text from an API or a viewer. */
  readonly reason: string
  readonly detail: Readonly<Record<string, HealthDetailValue>>
}

export interface AlertDeliveryResult {
  readonly delivered: boolean
  /** True when the sink dropped the alert on purpose (duplicate suppression). */
  readonly suppressed: boolean
  /** Machine-stable failure token; never a response body. */
  readonly error: string | null
}

export const DELIVERED: AlertDeliveryResult = Object.freeze({
  delivered: true,
  suppressed: false,
  error: null,
})

export interface AlertSink {
  /** Identity for logs and `/health`. Never contains a URL or a token. */
  readonly name: string
  deliver(alert: Alert): Promise<AlertDeliveryResult>
}

export const nullAlertSink: AlertSink = {
  name: 'null',
  deliver: () => Promise.resolve(DELIVERED),
}

/** Test double and the sink `/health` reads for the last few alerts. */
export class RecordingAlertSink implements AlertSink {
  readonly name = 'recording'
  readonly alerts: Alert[] = []

  deliver(alert: Alert): Promise<AlertDeliveryResult> {
    this.alerts.push(alert)
    return Promise.resolve(DELIVERED)
  }

  ofKind(kind: string): Alert[] {
    return this.alerts.filter((alert) => alert.kind === kind)
  }
}

/** Fans one alert out to several transports; one failure never hides another. */
export class CompositeAlertSink implements AlertSink {
  readonly name = 'composite'
  readonly #sinks: readonly AlertSink[]

  constructor(sinks: readonly AlertSink[]) {
    this.#sinks = sinks
  }

  async deliver(alert: Alert): Promise<AlertDeliveryResult> {
    const results = await Promise.all(this.#sinks.map((sink) => sink.deliver(alert)))
    const failed = results.filter((result) => !result.delivered && !result.suppressed)
    return {
      delivered: results.some((result) => result.delivered),
      suppressed: results.length > 0 && results.every((result) => result.suppressed),
      error: failed.length === 0 ? null : failed.map((result) => result.error).join(','),
    }
  }
}

/**
 * Duplicate suppression by `kind:reason`, with a per-severity window
 * (`supervisor.alerts.suppressWindowMs`, provisional, BOARD A-15). The first
 * alert of a key is always delivered; repeats inside the window are counted and
 * the count travels with the next delivered one, so a suppressed burst is
 * visible rather than lost.
 */
export class SuppressingAlertSink implements AlertSink {
  readonly name: string
  readonly #delegate: AlertSink
  readonly #config: SupervisorAlertConfig
  readonly #clock: Clock
  readonly #last = new Map<string, { atMonotonicMs: number; suppressed: number }>()

  constructor(options: {
    readonly delegate: AlertSink
    readonly config: SupervisorAlertConfig
    readonly clock: Clock
  }) {
    this.#delegate = options.delegate
    this.#config = options.config
    this.#clock = options.clock
    this.name = `suppressing(${options.delegate.name})`
  }

  async deliver(alert: Alert): Promise<AlertDeliveryResult> {
    const key = `${alert.kind}:${alert.reason}`
    const windowMs = this.#config.suppressWindowMs[alert.severity]
    const now = this.#clock.monotonicMs()
    const previous = this.#last.get(key)

    if (previous !== undefined && now - previous.atMonotonicMs < windowMs) {
      previous.suppressed += 1
      return { delivered: false, suppressed: true, error: null }
    }

    const suppressedSincePrevious = previous?.suppressed ?? 0
    this.#last.set(key, { atMonotonicMs: now, suppressed: 0 })
    return this.#delegate.deliver(
      suppressedSincePrevious === 0
        ? alert
        : { ...alert, detail: { ...alert.detail, suppressedSincePrevious } },
    )
  }
}

export interface DiscordWebhookAlertSinkOptions {
  /**
   * Resolves the webhook URL from the vault (`alerts.discordWebhookUrl`). A
   * function, not a string: the URL is a credential — it is fetched when an
   * alert is sent and never held in config, logs or `/health` (spec §10.2).
   */
  readonly webhookUrl: () => Promise<string | undefined>
  readonly config: SupervisorAlertConfig
  readonly clock: Clock
  readonly logger?: Logger
  readonly fetchImpl?: typeof fetch
}

/**
 * Discord webhook implementation of `AlertSink` (BOARD D-3).
 *
 * Sends one JSON `content` message per alert. Discord answers 204 on success
 * (https://discord.com/developers/docs/resources/webhook#execute-webhook,
 * checked 2026-08-18); anything else is a delivery failure that is logged with
 * its status and never retried in place — the supervisor's next evaluation
 * re-raises the condition, subject to suppression.
 */
export class DiscordWebhookAlertSink implements AlertSink {
  readonly name = 'discord-webhook'
  readonly #options: DiscordWebhookAlertSinkOptions
  readonly #fetch: typeof fetch
  readonly #logger: Logger

  constructor(options: DiscordWebhookAlertSinkOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch
    this.#logger = options.logger ?? silentLogger
  }

  async deliver(alert: Alert): Promise<AlertDeliveryResult> {
    let url: string | undefined
    try {
      url = await this.#options.webhookUrl()
    } catch (error) {
      return this.#failed(alert, `vault_unavailable:${errorToken(error)}`)
    }
    if (url === undefined || url === '') {
      return this.#failed(alert, 'webhook_url_not_configured')
    }

    const abort = new AbortController()
    const timeout = this.#options.clock.setTimeout(() => {
      abort.abort()
    }, this.#options.config.deliveryTimeoutMs)

    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: formatAlert(alert) }),
        signal: abort.signal,
      })
      if (response.status < 200 || response.status >= 300) {
        return this.#failed(alert, `http_${response.status}`)
      }
      return DELIVERED
    } catch (error) {
      return this.#failed(alert, errorToken(error))
    } finally {
      this.#options.clock.clearTimeout(timeout)
    }
  }

  #failed(alert: Alert, error: string): AlertDeliveryResult {
    // The URL is never logged: the token in its path is the credential.
    this.#logger.error('alert delivery failed', {
      sink: this.name,
      kind: alert.kind,
      severity: alert.severity,
      reason: alert.reason,
      error,
    })
    return { delivered: false, suppressed: false, error }
  }
}

export interface SlackWebhookAlertSinkOptions {
  /**
   * Resolves the webhook URL from the vault (`alerts.slackWebhookUrl`). A
   * function, not a string, for the same reason as the Discord sink: the URL is
   * the credential (spec §10.2).
   */
  readonly webhookUrl: () => Promise<string | undefined>
  readonly config: SupervisorAlertConfig
  readonly clock: Clock
  readonly logger?: Logger
  readonly fetchImpl?: typeof fetch
}

/**
 * Slack incoming-webhook implementation of `AlertSink` (BOARD D-3, amended
 * 2026-08-22).
 *
 * Sends one JSON `text` message per alert. Slack answers `200` with the body
 * `ok` on success and 400/403/404 otherwise
 * (https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks,
 * checked 2026-08-22); like the Discord sink, anything outside 2xx is a delivery
 * failure that is logged with its status and never retried in place.
 *
 * The published limit is one message per second per webhook
 * (https://docs.slack.dev/apis/web-api/rate-limits, checked 2026-08-22). No
 * queue guards it here: `SuppressingAlertSink` already holds repeats to one per
 * hour (info), 15 minutes (warning) or a minute (critical), which is far below
 * that line. A burst that crossed it would answer `429`, which reaches the
 * operator as `http_429` rather than as a silent drop.
 */
export class SlackWebhookAlertSink implements AlertSink {
  readonly name = 'slack-webhook'
  readonly #options: SlackWebhookAlertSinkOptions
  readonly #fetch: typeof fetch
  readonly #logger: Logger

  constructor(options: SlackWebhookAlertSinkOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch
    this.#logger = options.logger ?? silentLogger
  }

  async deliver(alert: Alert): Promise<AlertDeliveryResult> {
    let url: string | undefined
    try {
      url = await this.#options.webhookUrl()
    } catch (error) {
      return this.#failed(alert, `vault_unavailable:${errorToken(error)}`)
    }
    if (url === undefined || url === '') {
      return this.#failed(alert, 'webhook_url_not_configured')
    }

    const abort = new AbortController()
    const timeout = this.#options.clock.setTimeout(() => {
      abort.abort()
    }, this.#options.config.deliveryTimeoutMs)

    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: escapeSlackText(formatAlert(alert)) }),
        signal: abort.signal,
      })
      if (response.status < 200 || response.status >= 300) {
        return this.#failed(alert, `http_${response.status}`)
      }
      return DELIVERED
    } catch (error) {
      return this.#failed(alert, errorToken(error))
    } finally {
      this.#options.clock.clearTimeout(timeout)
    }
  }

  #failed(alert: Alert, error: string): AlertDeliveryResult {
    // The URL is never logged: the token in its path is the credential.
    this.#logger.error('alert delivery failed', {
      sink: this.name,
      kind: alert.kind,
      severity: alert.severity,
      reason: alert.reason,
      error,
    })
    return { delivered: false, suppressed: false, error }
  }
}

/**
 * Slack reads `&`, `<` and `>` as mrkdwn control characters, so a token that
 * happens to contain one would render as markup instead of as itself
 * (https://docs.slack.dev/messaging/formatting-message-text, checked
 * 2026-08-22). Escaping belongs to this sink: `formatAlert` is shared with the
 * Discord sink and with `/health`, which must keep the raw tokens.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * One line plus the machine-readable detail. Everything in it was produced by
 * this process — no API response body, no chat text, no author (§12.3, §12.4).
 */
export function formatAlert(alert: Alert): string {
  const detail = Object.entries(alert.detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
  const head = `[${alert.severity}] vertical-live ${alert.kind}: ${alert.reason} (${alert.at})`
  return detail === '' ? head : `${head}\n${detail}`
}

function errorToken(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ?? error.name
  }
  return 'unknown_error'
}
