import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  contentTypeFor,
  loadRendererStaticConfig,
  RendererStaticConfigError,
  resolveStaticPath,
  startRendererStaticServer,
  type StartedRendererStaticServer,
} from './static-server.js'

/**
 * Loopback static serving for the built renderer (TASK_SPECS §T17: the logon
 * autostart brings up 서버, 렌더러 정적 서빙, OBS). The properties that matter
 * are negative: nothing outside the served directory is reachable, and the
 * server binds to loopback only (spec §10.2).
 */

const root = mkdtempSync(join(tmpdir(), 'vl-static-'))
let started: StartedRendererStaticServer

beforeAll(async () => {
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>renderer</title>')
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'export const a = 1\n')
  writeFileSync(join(root, 'assets', 'scene.png'), 'png-bytes')
  // A file that only exists *outside* the served directory.
  writeFileSync(join(root, '..', 'vl-static-secret.txt'), 'do not serve me')

  started = await startRendererStaticServer({
    config: { directory: root, host: '127.0.0.1', port: 0 },
  })
})

afterAll(async () => {
  await started.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(join(root, '..', 'vl-static-secret.txt'), { force: true })
})

function base(): string {
  const address = started.server.address()
  if (address === null || typeof address === 'string') throw new Error('not listening on a port')
  return `http://127.0.0.1:${String(address.port)}`
}

describe('renderer static server', () => {
  it('serves index.html at the root and does not let it be cached', async () => {
    const response = await fetch(`${base()}/`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toContain('renderer')
  })

  it('serves the broadcast entry point with its query string', async () => {
    const response = await fetch(`${base()}/?mode=broadcast&token=synthetic-token`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<!doctype html>')
  })

  it('serves fingerprinted assets as immutable', async () => {
    const response = await fetch(`${base()}/assets/app-abc123.js`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('404s a missing asset instead of returning the page', async () => {
    const response = await fetch(`${base()}/assets/missing.js`)

    expect(response.status).toBe(404)
  })

  it('refuses to walk out of the served directory', async () => {
    for (const target of [
      '/../vl-static-secret.txt',
      '/..%2fvl-static-secret.txt',
      '/assets/../../vl-static-secret.txt',
      '/%2e%2e/vl-static-secret.txt',
    ]) {
      const response = await fetch(`${base()}${target}`)
      expect([400, 404]).toContain(response.status)
      expect(await response.text()).not.toContain('do not serve me')
    }
  })

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await fetch(`${base()}/`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    const post = await fetch(`${base()}/`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
  })
})

describe('resolveStaticPath', () => {
  const probe = {
    isFile: (path: string) => path.endsWith('index.html') || path.endsWith('app.js'),
    isDirectory: () => false,
  }

  it('falls back to index.html for a page-looking path', () => {
    expect(resolveStaticPath('/site', '/some/route', probe)).toEqual({
      path: resolve('/site', 'index.html'),
      fallback: true,
    })
  })

  it('does not fall back for a path that names a file extension', () => {
    expect(resolveStaticPath('/site', '/assets/missing.css', probe)).toBeNull()
  })

  it('rejects NUL bytes and undecodable targets', () => {
    expect(resolveStaticPath('/site', '/a%00b', probe)).toBeNull()
    expect(resolveStaticPath('/site', '/%E0%A4%A', probe)).toBeNull()
  })
})

describe('contentTypeFor', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('/a/b.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/a/b.WOFF2')).toBe('font/woff2')
    expect(contentTypeFor('/a/binary')).toBe('application/octet-stream')
    expect(contentTypeFor('/a/b.unknown')).toBe('application/octet-stream')
  })
})

describe('loadRendererStaticConfig', () => {
  it('loads the repository defaults', () => {
    const config = loadRendererStaticConfig()

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBeGreaterThan(0)
    expect(config.directory).toContain('renderer')
  })

  it('refuses a non-loopback bind address (spec §10.2)', () => {
    expect(() => loadRendererStaticConfig({ env: { VL_RENDERER_STATIC_HOST: '0.0.0.0' } })).toThrow(
      RendererStaticConfigError,
    )
  })

  it('takes env overrides for directory and port', () => {
    const config = loadRendererStaticConfig({
      env: { VL_RENDERER_STATIC_DIR: '/build', VL_RENDERER_STATIC_PORT: '5199' },
    })

    expect(config).toMatchObject({ directory: '/build', port: 5199 })
  })
})
