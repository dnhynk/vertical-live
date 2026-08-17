import OBSWebSocket, { type OBSEventTypes, type OBSRequestTypes, type OBSResponseTypes } from 'obs-websocket-js/json'

import { systemClock, type Clock, type TimerHandle } from '../clock.js'
import type { HealthSignal, HealthSignalSink } from '../health/types.js'
import { requireSecret, type SecretProvider } from '../secrets/index.js'
import { EnvSecretProvider } from '../secrets/env.js'
import { assertWebSocketUrl, type ObsConfig } from './config.js'
import { OBS_EVENT_SUBSCRIPTIONS, RPC_VERSION } from './protocol.js'

export type ObsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export const OBS_CONNECTION_SIGNAL = 'obs.connection'

export class ObsNotConnectedError extends Error {
  constructor(requestType: string) {
    super(`obs-websocket is not connected; refused request ${requestType}`)
    this.name = 'ObsNotConnectedError'
  }
}

export class ObsConnectTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`obs-websocket connect to ${url} timed out after ${timeoutMs}ms`)
    this.name = 'ObsConnectTimeoutError'
  }
}

export interface ObsClientOptions {
  readonly config: ObsConfig
  readonly secrets?: SecretProvider
  readonly clock?: Clock
  readonly onSignal?: HealthSignalSink
  /**
   * Allow connecting without a websocket password. Off by default: spec §10.2
   * requires authentication on the obs-websocket endpoint. Only the probe (with
   * an explicit flag) and tests against an auth-disabled fake server set it.
   */
  readonly allowUnauthenticated?: boolean
  /** Mirrors `loadObsConfig`; the URL is re-checked here because callers may build a config by hand. */
  readonly allowNonLoopback?: boolean
}

/**
 * obs-websocket v5 client: connect, authenticate, subscribe, request, and
 * reconnect with backoff.
 *
 * `obs-websocket-js` does not reconnect on its own, so the retry loop lives
 * here — this is the single restart supervisor for the "OBS connection"
 * component (spec §10.2). T12 supervises the OBS *process*; this class only
 * supervises the socket and reports what it observes.
 */
export class ObsClient {
  readonly #config: ObsConfig
  readonly #secrets: SecretProvider
  readonly #clock: Clock
  readonly #onSignal: HealthSignalSink | undefined
  readonly #allowUnauthenticated: boolean
  readonly #obs = new OBSWebSocket()

  #state: ObsConnectionState = 'disconnected'
  #stopped = true
  /** Enabled only once a connection has been established, so a refused first attempt does not loop. */
  #autoReconnect = false
  /** A connect attempt owns its own failure handling; the close listener stays out of the way. */
  #connectInFlight = false
  #retryTimer: TimerHandle | undefined
  #retryAttempt = 0
  #reconnectAttempts = 0
  #reconnectCount = 0
  #obsWebSocketVersion: string | undefined
  #negotiatedRpcVersion: number | undefined

  constructor(options: ObsClientOptions) {
    this.#config = options.config
    this.#secrets = options.secrets ?? new EnvSecretProvider()
    this.#clock = options.clock ?? systemClock
    this.#onSignal = options.onSignal
    this.#allowUnauthenticated = options.allowUnauthenticated === true
    assertWebSocketUrl(this.#config.url, options.allowNonLoopback === true)

    this.#obs.on('ConnectionClosed', () => {
      this.#handleUnexpectedClose()
    })
  }

  get state(): ObsConnectionState {
    return this.#state
  }

  get identified(): boolean {
    return this.#obs.identified
  }

  /** Successful reconnects since `connect()`. */
  get reconnectCount(): number {
    return this.#reconnectCount
  }

  /** Reconnect attempts (including failed ones) since `connect()`. */
  get reconnectAttempts(): number {
    return this.#reconnectAttempts
  }

  get obsWebSocketVersion(): string | undefined {
    return this.#obsWebSocketVersion
  }

  get negotiatedRpcVersion(): number | undefined {
    return this.#negotiatedRpcVersion
  }

  /**
   * One connect attempt. Throws on refusal (bad password, unsupported RPC
   * version, nothing listening). After it has succeeded once, an unexpected
   * close starts the backoff reconnect loop until `disconnect()`.
   */
  async connect(): Promise<void> {
    if (this.#state === 'connected') {
      return
    }
    this.#stopped = false
    this.#setState('connecting')
    try {
      await this.#openSocket()
    } catch (error) {
      this.#setState('disconnected', describeError(error))
      throw error
    }
  }

  /** Stops the reconnect loop and closes the socket. Safe to call when disconnected. */
  async disconnect(): Promise<void> {
    this.#stopped = true
    this.#autoReconnect = false
    this.#cancelRetry()
    await this.#obs.disconnect()
    this.#setState('disconnected', 'stopped')
  }

  async call<T extends keyof OBSRequestTypes>(
    requestType: T,
    requestData?: OBSRequestTypes[T],
  ): Promise<OBSResponseTypes[T]> {
    if (!this.#obs.identified) {
      throw new ObsNotConnectedError(String(requestType))
    }
    return this.#obs.call(requestType, requestData)
  }

  on<K extends keyof OBSEventTypes>(event: K, listener: (data: OBSEventTypes[K]) => void): void {
    this.#obs.on(event, listener as never)
  }

  off<K extends keyof OBSEventTypes>(event: K, listener: (data: OBSEventTypes[K]) => void): void {
    this.#obs.off(event, listener as never)
  }

  async #openSocket(): Promise<void> {
    const password = this.#allowUnauthenticated
      ? await this.#secrets.get('obs.websocketPassword')
      : await requireSecret(
          this.#secrets,
          'obs.websocketPassword',
          `set ${EnvSecretProvider.envVarFor('obs.websocketPassword')} (spec §10.2 requires authentication on obs-websocket)`,
        )

    this.#connectInFlight = true
    try {
      const connecting = this.#obs.connect(this.#config.url, password, {
        rpcVersion: RPC_VERSION,
        eventSubscriptions: OBS_EVENT_SUBSCRIPTIONS,
      })
      const hello = await this.#withTimeout(connecting, this.#config.connectTimeoutMs)

      this.#obsWebSocketVersion = hello.obsWebSocketVersion
      this.#negotiatedRpcVersion = hello.negotiatedRpcVersion
    } finally {
      this.#connectInFlight = false
    }

    this.#retryAttempt = 0
    this.#autoReconnect = true
    this.#setState('connected')
  }

  async #withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: TimerHandle | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = this.#clock.setTimeout(() => {
            reject(new ObsConnectTimeoutError(this.#config.url, timeoutMs))
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) {
        this.#clock.clearTimeout(timer)
      }
    }
  }

  #handleUnexpectedClose(): void {
    if (this.#stopped || this.#connectInFlight || !this.#autoReconnect) {
      return
    }
    this.#setState('reconnecting', 'connection_closed')
    this.#scheduleRetry()
  }

  #scheduleRetry(): void {
    this.#cancelRetry()
    const { initialDelayMs, maxDelayMs, factor } = this.#config.reconnect
    const delayMs = Math.min(maxDelayMs, initialDelayMs * Math.pow(factor, this.#retryAttempt))
    this.#retryAttempt += 1
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = undefined
      void this.#retry()
    }, delayMs)
  }

  async #retry(): Promise<void> {
    if (this.#stopped) {
      return
    }
    this.#reconnectAttempts += 1
    try {
      await this.#openSocket()
      this.#reconnectCount += 1
    } catch (error) {
      if (this.#stopped) {
        return
      }
      this.#setState('reconnecting', describeError(error))
      this.#scheduleRetry()
    }
  }

  #cancelRetry(): void {
    if (this.#retryTimer !== undefined) {
      this.#clock.clearTimeout(this.#retryTimer)
      this.#retryTimer = undefined
    }
  }

  #setState(state: ObsConnectionState, reason?: string): void {
    this.#state = state
    this.#emitConnectionSignal(reason)
  }

  #emitConnectionSignal(reason: string | undefined): void {
    if (this.#onSignal === undefined) {
      return
    }
    const signal: HealthSignal = {
      component: 'obs',
      name: OBS_CONNECTION_SIGNAL,
      status: this.#state === 'connected' ? 'ok' : this.#state === 'disconnected' ? 'unknown' : 'degraded',
      observedAtUtc: this.#clock.nowUtcIso(),
      observedAtMonotonicMs: this.#clock.monotonicMs(),
      ...(reason === undefined ? {} : { reason }),
      detail: {
        state: this.#state,
        url: this.#config.url,
        reconnectAttempts: this.#reconnectAttempts,
        reconnectCount: this.#reconnectCount,
        obsWebSocketVersion: this.#obsWebSocketVersion ?? null,
        negotiatedRpcVersion: this.#negotiatedRpcVersion ?? null,
      },
    }
    this.#onSignal(signal)
  }
}

/** Error text for a signal `reason`; never carries request payloads or secrets. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return 'unknown_error'
}
