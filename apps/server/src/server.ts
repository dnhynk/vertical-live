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
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
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
    sendJson(res, 200, {
      status: health.degraded ? 'degraded' : 'ok',
      engine: health,
      renderer: options.rendererHealth?.() ?? null,
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

  if (pathname === '/ingest/simulator') {
    const ingest = options.ingest
    if (ingest === undefined || !ingest.enabled) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    if (!isLoopbackAddress(req.socket.remoteAddress ?? null)) {
      sendJson(res, 403, { error: 'loopback_only' })
      return
    }
    void readJsonBody(req).then(
      (body) => {
        if (body === BODY_TOO_LARGE) {
          sendJson(res, 413, { error: 'body_too_large' })
          return
        }
        if (body === BODY_UNPARSEABLE) {
          sendJson(res, 400, { error: 'body_must_be_json' })
          return
        }
        const result = ingest.handle({
          authorization: headerValue(req, 'authorization'),
          remoteAddress: req.socket.remoteAddress ?? null,
          body,
        })
        sendJson(res, result.status, result.body)
      },
      () => {
        sendJson(res, 400, { error: 'body_must_be_json' })
      },
    )
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
