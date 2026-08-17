import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createServer, DEFAULT_PORT, resolvePort, type ServerOptions } from './server.js'
import type { EngineHealth } from './engine/engine.js'
import type { EngineMetricsSnapshot } from './engine/metrics.js'

describe('resolvePort', () => {
  it('falls back to the shared default', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT)
    expect(resolvePort({ VL_PORT: '' })).toBe(DEFAULT_PORT)
  })

  it('reads VL_PORT', () => {
    expect(resolvePort({ VL_PORT: '9123' })).toBe(9123)
  })

  it('rejects a non-port VL_PORT', () => {
    expect(() => resolvePort({ VL_PORT: 'abc' })).toThrow(/invalid VL_PORT/)
    expect(() => resolvePort({ VL_PORT: '70000' })).toThrow(/invalid VL_PORT/)
  })
})

describe('health server', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    server = createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('answers GET /health with {status:"ok"}', async () => {
    const response = await fetch(`${baseUrl}/health`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('rejects an unknown path with 404', async () => {
    const response = await fetch(`${baseUrl}/nope`)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'not_found' })
  })

  it('rejects a non-GET method on /health with 405', async () => {
    const response = await fetch(`${baseUrl}/health`, { method: 'POST' })

    expect(response.status).toBe(405)
    await expect(response.json()).resolves.toEqual({ error: 'method_not_allowed' })
  })

  it('has no /metrics and no simulator endpoint without an engine', async () => {
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/ingest/simulator`, { method: 'POST' })).status).toBe(404)
  })
})

/**
 * The observability surface of TASK_SPECS 공통 규약. A route whose collaborator
 * is absent must be indistinguishable from a path that does not exist — the
 * simulator endpoint in particular (§T11 acceptance 3).
 */
describe('engine-backed routes', () => {
  const health: EngineHealth = {
    ready: true,
    degraded: false,
    degradedReasons: [],
    interactionEnabled: true,
    stateRevision: 12,
    processedIngestSeq: 7,
    lastCommittedAt: '2026-08-16T00:05:00.000Z',
    openEffectCount: 1,
    rendererCount: 1,
    lastAckedStateRevision: 12,
    inputMode: 'direct',
    broadcastLifecycle: 'live',
    lastFailure: null,
    consecutiveFailures: 0,
  }
  const metrics: EngineMetricsSnapshot = {
    latencyMs: {
      receivedToCommitted: { count: 3, p50Ms: 4, p95Ms: 9, maxMs: 11 },
      committedToPublished: { count: 3, p50Ms: 0, p95Ms: 1, maxMs: 1 },
      publishedToAcked: { count: 3, p50Ms: 2, p95Ms: 3, maxMs: 3 },
      receivedToAcked: { count: 3, p50Ms: 7, p95Ms: 12, maxMs: 12 },
    },
    counters: { commit: 3 },
  }

  let server: Server
  let baseUrl: string
  let degraded = false

  const options: ServerOptions = {
    engine: {
      health: () =>
        degraded ? { ...health, degraded: true, degradedReasons: ['no_renderer'] } : health,
      metrics: () => metrics,
    },
    rendererHealth: () => null,
  }

  beforeEach(async () => {
    degraded = false
    server = createServer(options)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('reports the engine under /health', async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as {
      status: string
      engine: EngineHealth
      renderer: unknown
    }

    expect(body.status).toBe('ok')
    expect(body.engine).toEqual(health)
    expect(body.renderer).toBeNull()
  })

  it('reports degraded in the status line, not only in the detail', async () => {
    degraded = true
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as { status: string }

    expect(body.status).toBe('degraded')
  })

  it('serves the latency histograms under /metrics', async () => {
    const response = await fetch(`${baseUrl}/metrics`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(metrics)
  })

  it('rejects a non-GET method on /metrics', async () => {
    expect((await fetch(`${baseUrl}/metrics`, { method: 'POST' })).status).toBe(405)
  })
})
