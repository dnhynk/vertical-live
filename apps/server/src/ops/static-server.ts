import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { silentLogger, type Logger } from '../secrets/redaction.js'

/**
 * Loopback static serving for the built renderer.
 *
 * The renderer is a read model (spec §10.2) that OBS shows through a Browser
 * Source, so on the production host something has to serve
 * `apps/renderer/dist` next to the authoritative server. That is the third
 * process `ops/windows/Start-VerticalLive.ps1` starts, in order, before OBS
 * (TASK_SPECS §T17: 서버, 렌더러 정적 서빙, OBS).
 *
 * It is deliberately small and dependency-free: it answers GET/HEAD for files
 * under one directory, binds to loopback only (spec §10.2 "loopback 또는 명시적
 * 방화벽 allowlist"), and serves nothing it cannot resolve inside that
 * directory. It holds no state and no secret — the renderer token lives in the
 * vault and reaches the page through the Browser Source URL that the server
 * injects (BOARD A-16 custody), never through this process.
 */

export interface RendererStaticConfig {
  /** Directory to serve. Relative paths resolve against the process cwd. */
  readonly directory: string
  readonly host: string
  readonly port: number
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** `config/default.json` at the repository root, from `src/ops/` or `dist/ops/`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/default.json', import.meta.url),
)

export class RendererStaticConfigError extends Error {
  constructor(message: string) {
    super(`invalid renderer static config: ${message}`)
    this.name = 'RendererStaticConfigError'
  }
}

export interface LoadRendererStaticConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadRendererStaticConfig(
  options: LoadRendererStaticConfigOptions = {},
): RendererStaticConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
  } catch (error) {
    throw new RendererStaticConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }

  const root = parsed as Record<string, unknown>
  const section = root['renderer']
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new RendererStaticConfigError('renderer must be an object')
  }
  const values = section as Record<string, unknown>

  const directory = env['VL_RENDERER_STATIC_DIR'] ?? values['staticDir']
  if (typeof directory !== 'string' || directory === '') {
    throw new RendererStaticConfigError('renderer.staticDir must be a non-empty string')
  }

  const host = String(env['VL_RENDERER_STATIC_HOST'] ?? values['host'] ?? '')
  if (!LOOPBACK_HOSTS.has(host)) {
    // Spec §10.2 binds the renderer API to loopback; the static page is served
    // to the Browser Source on the same host and has no reason to leave it.
    throw new RendererStaticConfigError(`renderer.host must be loopback (got ${JSON.stringify(host)})`)
  }

  const port = Number(env['VL_RENDERER_STATIC_PORT'] ?? values['port'])
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new RendererStaticConfigError('renderer.port must be a TCP port')
  }

  return Object.freeze({ directory, host, port })
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

export interface ResolvedStaticPath {
  readonly path: string
  /** True when the request fell back to `index.html` (client-side routing). */
  readonly fallback: boolean
}

export interface StaticFileProbe {
  isFile(path: string): boolean
  isDirectory(path: string): boolean
}

const nodeProbe: StaticFileProbe = {
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
}

/**
 * Maps a request target onto a file inside `rootDirectory`, or `null` when it
 * cannot.
 *
 * Everything that could leave the directory is rejected here rather than
 * sanitised: `..` segments, absolute or UNC targets, encoded separators and NUL
 * bytes. A request that names no file falls back to `index.html` only when it
 * looks like a page (no extension) — an asset that is genuinely missing must
 * 404 instead of quietly returning HTML.
 */
export function resolveStaticPath(
  rootDirectory: string,
  requestTarget: string,
  probe: StaticFileProbe = nodeProbe,
): ResolvedStaticPath | null {
  const root = resolve(rootDirectory)

  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(requestTarget, 'http://127.0.0.1').pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null

  const relativeTarget = pathname.replace(/^\/+/, '')
  if (relativeTarget.split(/[\\/]/).includes('..')) return null

  const candidate = relativeTarget === '' ? join(root, 'index.html') : resolve(root, relativeTarget)
  const inside = relative(root, candidate)
  if (inside.startsWith('..') || isAbsolute(inside)) return null

  if (probe.isFile(candidate)) return { path: candidate, fallback: false }

  if (probe.isDirectory(candidate)) {
    const directoryIndex = join(candidate, 'index.html')
    if (probe.isFile(directoryIndex)) return { path: directoryIndex, fallback: false }
  }

  const hasExtension = /\.[^/\\]+$/.test(relativeTarget)
  if (hasExtension) return null

  const index = join(root, 'index.html')
  return probe.isFile(index) ? { path: index, fallback: true } : null
}

export interface RendererStaticServerOptions {
  readonly config: RendererStaticConfig
  readonly logger?: Logger
  readonly probe?: StaticFileProbe
}

export function createRendererStaticServer(options: RendererStaticServerOptions): Server {
  const logger = options.logger ?? silentLogger
  const probe = options.probe ?? nodeProbe
  const root = resolve(options.config.directory)

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }

    const resolved = resolveStaticPath(root, request.url ?? '/', probe)
    if (resolved === null) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n')
      return
    }

    let size: number
    try {
      size = statSync(resolved.path).size
    } catch (error) {
      logger.warn('static file disappeared between probe and read', {
        error: error instanceof Error ? error.message : String(error),
      })
      response.writeHead(404).end()
      return
    }

    // The entry point must never be cached: a new build has to reach the
    // Browser Source on a plain refresh. Vite fingerprints everything else.
    const isEntryPoint = resolved.fallback || resolved.path.endsWith('index.html')
    response.writeHead(200, {
      'content-type': contentTypeFor(resolved.path),
      'content-length': size,
      'cache-control': isEntryPoint ? 'no-store' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    if (method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(resolved.path).pipe(response)
  })
}

export interface StartedRendererStaticServer {
  readonly server: Server
  readonly url: string
  close(): Promise<void>
}

export async function startRendererStaticServer(
  options: RendererStaticServerOptions,
): Promise<StartedRendererStaticServer> {
  const server = createRendererStaticServer(options)
  const { host, port } = options.config
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  return {
    server,
    url: `http://${host}:${String(port)}/`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done()
        })
      }),
  }
}
