import { systemClock, type Clock, type TimerHandle } from '../clock.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { DeadManConfig } from './config.js'
import type { DeadManStatus } from './types.js'

/**
 * Dead-man monitor (spec §9.4(8), §11 관측성, [S23]).
 *
 * The host cannot observe its own power loss, so the only honest liveness check
 * is one an *external* monitor draws a conclusion from: this process pushes a
 * heartbeat to an Uptime Kuma push monitor, and Kuma raises the incident when
 * the pushes stop. The push URL carries its token in the path
 * (`/api/push/<token>`, https://github.com/louislam/uptime-kuma/wiki/Push-Monitor,
 * checked 2026-08-18), so it is a vault entry (`monitoring.deadManPushUrl`) and
 * is never logged, reported on `/health`, or put in `config/default.json`.
 *
 * What this class deliberately does **not** do: decide anything. A failed push
 * says this host could not reach the monitor; it does not say the broadcast is
 * bad, and `supervisor.requiredFamilies` leaves `dead_man` out for that reason.
 * The off-host record of an outage lives in the external monitor by design —
 * that is the whole point of it being off-host — and nothing here mirrors it.
 */

export interface DeadManMonitorOptions {
  /** Resolves the push URL from the vault; `undefined` when not provisioned. */
  readonly pushUrl: () => Promise<string | undefined>
  readonly config: DeadManConfig
  readonly clock?: Clock
  readonly logger?: Logger
  readonly fetchImpl?: typeof fetch
  /** Short status word sent as Kuma's `msg`, e.g. the supervisor state. */
  readonly message?: () => string
}

export class DeadManMonitor {
  readonly #options: DeadManMonitorOptions
  readonly #config: DeadManConfig
  readonly #clock: Clock
  readonly #logger: Logger
  readonly #fetch: typeof fetch

  #running = false
  #timer: TimerHandle | undefined
  #lastPushAt: string | null = null
  #lastPushOk: boolean | null = null
  #consecutiveFailures = 0
  #lastError: string | null = null

  constructor(options: DeadManMonitorOptions) {
    this.#options = options
    this.#config = options.config
    this.#clock = options.clock ?? systemClock
    this.#logger = options.logger ?? silentLogger
    this.#fetch = options.fetchImpl ?? fetch
  }

  get running(): boolean {
    return this.#running
  }

  status(): DeadManStatus {
    return {
      enabled: this.#config.enabled,
      lastPushAt: this.#lastPushAt,
      lastPushOk: this.#lastPushOk,
      consecutiveFailures: this.#consecutiveFailures,
      lastError: this.#lastError,
    }
  }

  /** Schedules the first push one interval out. `push()` sends one now. */
  start(): void {
    if (this.#running || !this.#config.enabled) return
    this.#running = true
    this.#scheduleNext()
  }

  stop(): void {
    if (!this.#running) return
    this.#running = false
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  /** One heartbeat. Never rejects: a failed push is recorded, not thrown. */
  async push(): Promise<boolean> {
    if (!this.#config.enabled) return false

    let base: string | undefined
    try {
      base = await this.#options.pushUrl()
    } catch (error) {
      return this.#record(false, `vault_unavailable:${errorToken(error)}`)
    }
    if (base === undefined || base === '') {
      return this.#record(false, 'push_url_not_configured')
    }

    let url: URL
    try {
      url = new URL(base)
    } catch {
      // The URL itself is never echoed — it is the credential.
      return this.#record(false, 'push_url_malformed')
    }
    url.searchParams.set('status', 'up')
    url.searchParams.set('msg', this.#options.message?.() ?? 'ok')

    const abort = new AbortController()
    const timeout = this.#clock.setTimeout(() => {
      abort.abort()
    }, this.#config.requestTimeoutMs)
    try {
      const response = await this.#fetch(url, { signal: abort.signal })
      return response.status >= 200 && response.status < 300
        ? this.#record(true, null)
        : this.#record(false, `http_${response.status}`)
    } catch (error) {
      return this.#record(false, errorToken(error))
    } finally {
      this.#clock.clearTimeout(timeout)
    }
  }

  #record(ok: boolean, error: string | null): boolean {
    this.#lastPushAt = this.#clock.nowUtcIso()
    this.#lastPushOk = ok
    this.#lastError = error
    if (ok) {
      this.#consecutiveFailures = 0
    } else {
      this.#consecutiveFailures += 1
      this.#logger.warn('dead-man push failed', {
        error,
        consecutiveFailures: this.#consecutiveFailures,
      })
    }
    return ok
  }

  #scheduleNext(): void {
    if (!this.#running) return
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      void this.push().then(() => {
        this.#scheduleNext()
      })
    }, this.#config.intervalMs)
  }
}

function errorToken(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ?? error.name
  }
  return 'unknown_error'
}
