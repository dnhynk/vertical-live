import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

import type { EngineHealth } from './engine/engine.js'
import type { SimulatorIngestEndpoint } from './engine/ingest.js'
import { isLoopbackAddress } from './engine/ingest.js'
import type { EngineMetricsSnapshot } from './engine/metrics.js'
import type { RendererHealthReport } from './engine/publisher.js'
import type { HealthSignal } from './health/types.js'
import type { AdminKillEndpoint } from './supervisor/kill-switch.js'
import type { SupervisorHealthSummary } from './supervisor/types.js'

/** Loopback only: the server is never bound to a routable interface (spec §10.2). */
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787

/** Largest accepted request body. A simulator batch is JSON, not a file. */
const MAX_BODY_BYTES = 1_000_000

/** Resolve the listen port from `VL_PORT`, falling back to the shared default. */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['VL_PORT']
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid VL_PORT: ${raw}`)
  }
  return parsed
}

/**
 * What the HTTP surface needs from the engine. It is a read port on purpose:
 * `GET /health` and `GET /metrics` observe the writer, they never poke it
 * (spec §9.4, §7.3(8)).
 */
export interface EngineHttpPort {
  health(): EngineHealth
  metrics(): EngineMetricsSnapshot
}

export interface ServerOptions {
  /** Absent in the bare health server of T0 and in the unit tests of routing. */
  readonly engine?: EngineHttpPort
  readonly ingest?: SimulatorIngestEndpoint
  /** Last renderer health frame, reported under `/health` (spec §9.4(4)). */
  readonly rendererHealth?: () => RendererHealthReport | null
  /**
   * Chat source signals, reported under `/health` (spec §9.4(3)). They are
   * reported, never folded into the top-level `status`: only the supervisor of
   * T12 decides what a chat transport state means for the broadcast, and a
   * quiet chat is not a fault.
   */
  readonly sourceHealth?: () => readonly HealthSignal[]
  /**
   * T12's state machine and its §9.4 family summary. Absent in the bare health
   * server and in the unit tests of routing; present in `main.ts`.
   */
  readonly supervisorHealth?: () => SupervisorHealthSummary | null
  /** `POST /admin/kill` (loopback + `server.adminToken`, spec §10.2). */
  readonly adminKill?: AdminKillEndpoint
}

/**
 * Top-level `/health` status line.
 *
 * Without a supervisor it is the engine's own verdict, as it was before T12.
 * With one, the supervisor is the authority (spec §9.2): a run that is stopped
 * for a rights or policy reason must not answer `ok` because the writer inside
 * it happens to be fine.
 */
function statusLine(engine: EngineHealth, supervisor: SupervisorHealthSummary | null): string {
  if (supervisor === null) return engine.degraded ? 'degraded' : 'ok'
  switch (supervisor.state) {
    case 'safe_stopped':
      return 'safe_stopped'
    case 'offline':
    case 'starting':
      return supervisor.state
    case 'live':
      return engine.degraded ? 'degraded' : 'ok'
    default:
      return 'degraded'
  }
}

/**
 * Last resort: end a request whose handler threw after the body was read.
 *
 * `void readJsonBody(req).then(onFulfilled, onRejected)` looks like it covers
 * both outcomes, but `onRejected` only sees rejections of the promise it is
 * attached to. A throw *inside* `onFulfilled` rejects the promise `.then()`
 * returns instead, and `void` discards it — so the exception became an unhandled
 * rejection and the response was never written at all. The caller waited until it
 * gave up (T8b; found by T15's fault matrix drill, where an inbox write hit
 * `SQLITE_BUSY`).
 *
 * A route maps the failures it can name — see `SimulatorIngestEndpoint` for the
 * 503/500 split on an inbox write. This is what guarantees the request ends even
 * when it cannot: a bare `internal_error`, with no detail from the exception,
 * because nothing here knows what the exception is carrying.
 */
function failClosed(
  res: ServerResponse,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.writableEnded) return
  // Headers already out means part of an answer was sent; the only thing left to
  // do is stop the caller from waiting for the rest of it.
  if (res.headersSent) {
    res.end()
    return
  }
  sendJson(res, 500, { error: 'internal_error' }, headers)
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

/**
 * CORS for `POST /ingest/simulator`, and only for it.
 *
 * The renderer's `?mode=dev` panel injects events through this endpoint (§T11),
 * and it is served from a different loopback port than the API — Vite in
 * development, a static preview in OBS — so the browser sends a preflight for
 * the `Authorization` header and refuses to read the answer without these
 * headers.
 *
 * Two limits keep it from becoming a hole:
 *
 * - the caller's `Origin` is **echoed only if it is itself loopback**; there is
 *   no `*`, and a page from anywhere else gets no CORS headers at all and so
 *   cannot read a response;
 * - the headers only exist while `simulator.enabled` is true. On a production
 *   broadcast the endpoint answers 404 to every method, preflight included, and
 *   is indistinguishable from a path that was never routed (§T11 acceptance 3).
 *
 * None of this replaces the checks: loopback address, bearer token and schema
 * validation still run on the POST itself.
 */
function simulatorCorsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = headerValue(req, 'origin')
  if (origin === null || !isLoopbackOrigin(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
}

/**
 * Routing table (TASK_SPECS 공통 규약): `GET /health`, `GET /metrics`,
 * `POST /ingest/simulator`. A route whose collaborator is absent answers 404
 * rather than pretending to exist — the simulator endpoint in particular must be
 * indistinguishable from a missing path while it is disabled (§T11 acceptance 3).
 */
export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions = {},
): void {
  const method = req.method ?? 'GET'
  const { pathname } = new URL(req.url ?? '/', `http://${DEFAULT_HOST}`)

  if (pathname === '/health') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    if (options.engine === undefined) {
      sendJson(res, 200, { status: 'ok' })
      return
    }
    const health = options.engine.health()
    const supervisor = options.supervisorHealth?.() ?? null
    sendJson(res, 200, {
      status: statusLine(health, supervisor),
      engine: health,
      renderer: options.rendererHealth?.() ?? null,
      sources: options.sourceHealth?.() ?? [],
      supervisor,
    })
    return
  }

  if (pathname === '/metrics') {
    if (options.engine === undefined) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    sendJson(res, 200, options.engine.metrics())
    return
  }

  if (pathname === '/admin/kill') {
    const adminKill = options.adminKill
    // Unlike the simulator endpoint, the kill switch is not a feature flag: it
    // is absent only when nothing in this process can be stopped (the bare
    // health server), so a missing collaborator is a plain 404.
    if (adminKill === undefined) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    void readJsonBody(req)
      .then(
        (body) => {
          if (body === BODY_TOO_LARGE) {
            sendJson(res, 413, { error: 'body_too_large' })
            return
          }
          // A kill switch must work with an empty body: the reason is optional and
          // an operator with a wedged broadcast should not have to get JSON right.
          const result = adminKill.handle({
            authorization: headerValue(req, 'authorization'),
            remoteAddress: req.socket.remoteAddress ?? null,
            body: body === BODY_UNPARSEABLE ? null : body,
          })
          sendJson(res, result.status, result.body)
        },
        () => {
          const result = adminKill.handle({
            authorization: headerValue(req, 'authorization'),
            remoteAddress: req.socket.remoteAddress ?? null,
            body: null,
          })
          sendJson(res, result.status, result.body)
        },
      )
      // The kill switch reaches the supervisor, so `handle()` can throw for
      // reasons this route cannot enumerate. An operator killing a wedged
      // broadcast must not be left holding an open socket either.
      .catch(() => {
        failClosed(res)
      })
    return
  }

  if (pathname === '/ingest/simulator') {
    const ingest = options.ingest
    if (ingest === undefined || !ingest.enabled) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const cors = simulatorCorsHeaders(req)
    if (!isLoopbackAddress(req.socket.remoteAddress ?? null)) {
      sendJson(res, 403, { error: 'loopback_only' })
      return
    }
    if (method === 'OPTIONS') {
      // Preflight: it carries no `Authorization` header by definition, so it is
      // answered on the loopback check alone. It grants nothing — the POST it
      // precedes is still authenticated and validated.
      res.writeHead(204, { ...cors, 'content-length': 0 })
      res.end()
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' }, cors)
      return
    }
    void readJsonBody(req)
      .then(
        (body) => {
          if (body === BODY_TOO_LARGE) {
            sendJson(res, 413, { error: 'body_too_large' }, cors)
            return
          }
          if (body === BODY_UNPARSEABLE) {
            sendJson(res, 400, { error: 'body_must_be_json' }, cors)
            return
          }
          const result = ingest.handle({
            authorization: headerValue(req, 'authorization'),
            remoteAddress: req.socket.remoteAddress ?? null,
            body,
          })
          sendJson(res, result.status, result.body, cors)
        },
        () => {
          sendJson(res, 400, { error: 'body_must_be_json' }, cors)
        },
      )
      .catch(() => {
        failClosed(res, cors)
      })
    return
  }

  sendJson(res, 404, { error: 'not_found' })
}

export function createServer(options: ServerOptions = {}): Server {
  return createHttpServer((req, res) => {
    handleRequest(req, res, options)
  })
}

const BODY_TOO_LARGE = Symbol('body_too_large')
const BODY_UNPARSEABLE = Symbol('body_unparseable')

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return BODY_TOO_LARGE
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return BODY_UNPARSEABLE
  try {
    return JSON.parse(raw)
  } catch {
    return BODY_UNPARSEABLE
  }
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}
