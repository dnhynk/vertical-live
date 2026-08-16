import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createServer, DEFAULT_PORT, resolvePort } from './server.js'

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
})
