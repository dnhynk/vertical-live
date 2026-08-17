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
  readonly wsUrl: string
  readonly rendererId: RendererId
  readonly backoff: BackoffConfig
  readonly healthIntervalMs: number
  readonly provisional: readonly string[]
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
 * The `/ws/renderer` URL, with the renderer token carried over from the page
 * query string.
 *
 * The server authenticates the upgrade (spec §10.2), and an OBS Browser Source
 * can only pass values through its URL, so the token arrives as `?token=` on the
 * page and is forwarded to the socket URL. It is never logged and never stored:
 * `config_token_missing` records the absence, not the value, and the renderer
 * keeps nothing across a reload (spec §10.2, §12.4).
 */
function readWsUrl(params: URLSearchParams, log: RendererLog): string {
  const raw = params.get('ws')
  let base = DEFAULT_WS_URL
  if (raw !== null) {
    if (isLoopbackWebSocketUrl(raw)) base = raw
    else log.warn('config_ws_rejected')
  }
  const token = params.get('token')
  if (token === null || token === '') {
    // Left as-is: the server refuses the upgrade with 4401 and the connection
    // log says why. Inventing a token here would only hide the misconfiguration.
    log.warn('config_token_missing')
    return base
  }
  const url = new URL(base)
  url.searchParams.set('token', token)
  return url.toString()
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
  return {
    mode: readMode(params, options.log),
    wsUrl: readWsUrl(params, options.log),
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
