import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

/** Loopback only: the server is never bound to a routable interface (spec §10.2). */
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787

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

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * T0 routing table: only `GET /health` exists. Everything else is rejected so
 * that the reject path is exercised from the first commit.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET'
  const { pathname } = new URL(req.url ?? '/', `http://${DEFAULT_HOST}`)

  if (pathname === '/health') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }
    sendJson(res, 200, { status: 'ok' })
    return
  }

  sendJson(res, 404, { error: 'not_found' })
}

export function createServer(): Server {
  return createHttpServer(handleRequest)
}
