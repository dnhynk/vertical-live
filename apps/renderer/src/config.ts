import { RendererIdSchema, type RendererId } from '@vl/contract'

import type { BackoffConfig } from './read-model/connection'
import type { RendererLog } from './read-model/log'

/**
 * Renderer configuration, read from the query string of the URL that OBS (or a
 * developer) opens. There is no local storage anywhere in the renderer: a
 * refresh recovers from the server snapshot alone (spec §10.2).
 *
 * Every number below is `provisional` in the sense of BOARD A-15 — the spec
 * fixes none of them — and is listed in `PROVISIONAL_CONFIG_KEYS`.
 */

export type RendererMode = 'broadcast' | 'dev'

/** Fixed 9:16 1080x1920 coordinate system (spec §11 "화면", TASK_SPECS §T5). */
export const STAGE_WIDTH = 1080
export const STAGE_HEIGHT = 1920

/** Loopback server of the common conventions (BOARD A-14). */
export const DEFAULT_WS_URL = 'ws://127.0.0.1:8787/ws/renderer'

export const DEFAULT_BACKOFF: BackoffConfig = {
  initialMs: 500,
  maxMs: 15_000,
  factor: 2,
  jitterRatio: 0.2,
}

export const DEFAULT_HEALTH_INTERVAL_MS = 1_000

export const PROVISIONAL_CONFIG_KEYS = [
  'backoff.initialMs',
  'backoff.maxMs',
  'backoff.factor',
  'backoff.jitterRatio',
  'healthIntervalMs',
  'effectRetentionMs',
  'maxRememberedEffects',
  'webglRestoreDelayMs',
] as const

export interface RendererConfig {
  readonly mode: RendererMode
  /**
   * Whether the generated ambient bed plays (`?audio=off` turns it off).
   *
   * On by default and switchable from the Browser Source URL, because the only
   * way to silence a browser source otherwise is to change the OBS scene, and
   * the person who needs the sound gone is usually mid-broadcast.
   */
  readonly audioEnabled: boolean
  /**
   * The `/ws/renderer` URL **without** the token: this is the value anything on
   * screen or in a log may use.
   *
   * The split is structural on purpose. The dev panel renders configuration
   * verbatim, so a single field holding both the address and a vault secret put
   * that secret on air the moment `?mode=dev` was opened (R-T8-2 blocker 1).
   * Keeping the secret out of the field everything reads means a future panel,
   * log line or diagnostic cannot leak it by being written the obvious way.
   */
  readonly wsUrl: string
  /**
   * `server.rendererToken` from the page query string, or `null` when the page
   * was opened without one. Only `authenticatedWsUrl()` reads it (spec §10.2).
   */
  readonly wsToken: string | null
  /**
   * The server's HTTP origin, derived from `wsUrl`. It carries no secret and is
   * safe to draw; the `?mode=dev` injection panel posts to
   * `${apiUrl}/ingest/simulator` (TASK_SPECS §T11).
   */
  readonly apiUrl: string
  /**
   * `server.simulatorToken`, for the `?mode=dev` injection panel only. It is a
   * vault secret and follows exactly the same rule as `wsToken`: it is never
   * rendered, never logged and never stored (spec §10.2, R-T8-2 blocker 1).
   */
  readonly simToken: string | null
  readonly rendererId: RendererId
  readonly backoff: BackoffConfig
  readonly healthIntervalMs: number
  readonly provisional: readonly string[]
}

/**
 * The URL the socket actually opens: `wsUrl` plus the token the server checks on
 * the upgrade. This is the *only* place the two are put back together, and its
 * result must never be rendered or logged.
 */
export function authenticatedWsUrl(config: RendererConfig): string {
  if (config.wsToken === null) return config.wsUrl
  const url = new URL(config.wsUrl)
  url.searchParams.set('token', config.wsToken)
  return url.toString()
}

/**
 * Strips a `token` parameter from any URL, for diagnostics that were handed a
 * URL rather than a `RendererConfig`.
 */
export function redactWsUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  parsed.searchParams.delete('token')
  return parsed.toString()
}

/**
 * The renderer API is bound to loopback (spec §10.2), so an override may only
 * point at this host. A non-loopback override is refused, not honoured.
 */
export function isLoopbackWebSocketUrl(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
}

function readMode(params: URLSearchParams, log: RendererLog): RendererMode {
  const raw = params.get('mode')
  if (raw === null) return 'broadcast'
  if (raw === 'broadcast' || raw === 'dev') return raw
  // An unknown mode falls back to the broadcast screen: a typo in the OBS
  // Browser Source URL must not put a debug panel on air.
  log.warn('config_mode_rejected')
  return 'broadcast'
}

/**
 * `?audio=off` silences the generated bed. Anything else, including an absent
 * parameter, leaves it on — a typo in the Browser Source URL must not silently
 * take the sound off air, the same rule `readMode` follows for the dev panel.
 */
function readAudioEnabled(params: URLSearchParams, log: RendererLog): boolean {
  const raw = params.get('audio')
  if (raw === null || raw === 'on') return true
  if (raw === 'off') return false
  log.warn('config_audio_rejected')
  return true
}

/**
 * The `/ws/renderer` address, with any `token` parameter removed.
 *
 * A `token` in the `ws=` override is dropped here rather than carried: the token
 * has exactly one channel into this renderer (the page's own `?token=`), and
 * accepting a second one would mean a URL on screen could contain a secret again.
 */
function readWsUrl(params: URLSearchParams, log: RendererLog): string {
  const raw = params.get('ws')
  if (raw === null) return DEFAULT_WS_URL
  if (isLoopbackWebSocketUrl(raw)) return redactWsUrl(raw)
  log.warn('config_ws_rejected')
  return DEFAULT_WS_URL
}

/**
 * The renderer token from the page query string.
 *
 * The server authenticates the upgrade (spec §10.2) and an OBS Browser Source can
 * only pass values through its URL, so the token arrives as `?token=`. It is
 * never logged and never stored: `config_token_missing` records the absence, not
 * the value, and the renderer keeps nothing across a reload (§10.2, §12.4).
 */
function readWsToken(params: URLSearchParams, log: RendererLog): string | null {
  const token = params.get('token')
  if (token === null || token === '') {
    // Left absent: the server refuses the upgrade with 4401 and the connection
    // log says why. Inventing a token here would only hide the misconfiguration.
    log.warn('config_token_missing')
    return null
  }
  return token
}

/**
 * `server.simulatorToken` from the page query string.
 *
 * Only `?mode=dev` can use it, and the endpoint it unlocks answers 404 unless
 * `simulator.enabled` is true (§T11 acceptance 3). Absence is normal — the
 * panel then shows the injection controls as unavailable rather than pretending
 * they work.
 */
function readSimToken(params: URLSearchParams): string | null {
  const token = params.get('simToken')
  return token === null || token === '' ? null : token
}

/** `ws://host:port/ws/renderer` → `http://host:port`. Never carries a token. */
export function apiUrlFrom(wsUrl: string): string {
  let url: URL
  try {
    url = new URL(wsUrl)
  } catch {
    return ''
  }
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`
}

function readRendererId(
  params: URLSearchParams,
  log: RendererLog,
  generateRendererId: () => string,
): RendererId {
  const raw = params.get('rendererId')
  if (raw !== null) {
    const parsed = RendererIdSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    log.warn('config_renderer_id_rejected')
  }
  const generated = RendererIdSchema.safeParse(generateRendererId())
  if (generated.success) return generated.data
  log.warn('config_renderer_id_generation_rejected')
  return 'renderer'
}

/**
 * `rendererId` identifies this browser instance to the server, not a person. It
 * is generated per page load and never persisted (spec §12.4, BOARD A-1).
 */
export function defaultRendererIdFactory(): string {
  return `renderer-${crypto.randomUUID()}`
}

export interface ReadRendererConfigOptions {
  search: string
  log: RendererLog
  generateRendererId?: () => string
}

export function readRendererConfig(options: ReadRendererConfigOptions): RendererConfig {
  const params = new URLSearchParams(options.search)
  const wsUrl = readWsUrl(params, options.log)
  return {
    mode: readMode(params, options.log),
    audioEnabled: readAudioEnabled(params, options.log),
    wsUrl,
    wsToken: readWsToken(params, options.log),
    apiUrl: apiUrlFrom(wsUrl),
    simToken: readSimToken(params),
    rendererId: readRendererId(
      params,
      options.log,
      options.generateRendererId ?? defaultRendererIdFactory,
    ),
    backoff: DEFAULT_BACKOFF,
    healthIntervalMs: DEFAULT_HEALTH_INTERVAL_MS,
    provisional: PROVISIONAL_CONFIG_KEYS,
  }
}
