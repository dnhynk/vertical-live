import http from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { isPlainHttpUrl, requestJson } from './loopback-http.js'

/**
 * The loopback client of TASK_SPECS §T8f. What these pin: it still speaks real
 * HTTP and still reports the status the endpoint chose, so the refusal paths a
 * scenario has to exercise (404, 403, 401, 400) reach the caller unchanged.
 */

let server: http.Server | null = null

afterEach(async () => {
  const active = server
  server = null
  if (active !== null) await new Promise<void>((resolve) => active.close(() => resolve()))
})

async function listen(handler: http.RequestListener): Promise<string> {
  const active = http.createServer(handler)
  server = active
  await new Promise<void>((resolve) => active.listen(0, '127.0.0.1', () => resolve()))
  const address = active.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

describe('requestJson', () => {
  it('posts a body and returns the status with the parsed JSON', async () => {
    const seen: { method?: string; body: string; auth?: string }[] = []
    const base = await listen((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({
          ...(req.method === undefined ? {} : { method: req.method }),
          body: Buffer.concat(chunks).toString('utf8'),
          ...(typeof req.headers.authorization === 'string'
            ? { auth: req.headers.authorization }
            : {}),
        })
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end('{"inserted":1}')
      })
    })

    const response = await requestJson(`${base}/ingest/simulator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic' },
      body: '{"envelopes":[]}',
    })

    expect(response).toEqual({ status: 202, body: { inserted: 1 } })
    expect(seen).toEqual([{ method: 'POST', body: '{"envelopes":[]}', auth: 'Bearer synthetic' }])
  })

  it('carries a refusal status through instead of throwing', async () => {
    const base = await listen((req, res) => {
      req.resume()
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
    })

    await expect(
      requestJson(`${base}/ingest/simulator`, { method: 'POST', body: '{}' }),
    ).resolves.toEqual({ status: 401, body: { error: 'unauthorized' } })
  })

  it('reports a body that is empty or not JSON as null, keeping the status', async () => {
    const base = await listen((req, res) => {
      req.resume()
      res.writeHead(204)
      res.end()
    })

    await expect(requestJson(`${base}/health`, { method: 'GET' })).resolves.toEqual({
      status: 204,
      body: null,
    })
  })

  it('rejects when the transport fails rather than inventing a status', async () => {
    // Nothing is listening on this port: the connection is refused.
    await expect(requestJson('http://127.0.0.1:1/metrics', { method: 'GET' })).rejects.toThrow()
  })
})

describe('isPlainHttpUrl', () => {
  it('takes the node:http path only for http, so a TLS target still uses fetch', () => {
    expect(isPlainHttpUrl('http://127.0.0.1:8787/metrics')).toBe(true)
    expect(isPlainHttpUrl('https://example.invalid/metrics')).toBe(false)
    expect(isPlainHttpUrl('not a url')).toBe(false)
  })
})
