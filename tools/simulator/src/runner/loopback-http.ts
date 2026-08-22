import http from 'node:http'

/**
 * The HTTP client the simulator uses for its own loopback calls.
 *
 * Node 26's `fetch` (undici) stalls for hundreds of milliseconds on **loopback
 * plain HTTP** whenever requests are not back to back — measured 2026-08-22 on
 * Windows 11 with a 12-line reproduction that uses no project code: a 20 ms gap
 * between requests takes `fetch` from 0.7 ms to a 474 ms median, a 1 s gap to
 * ~2 s, while `node:http` stays at 0.7-0.9 ms and Node 24's `fetch` stays at
 * ~10 ms. External HTTPS is unaffected, so the server's own outbound paths
 * (YouTube, Slack, dead-man) keep using `fetch`; only this loopback client
 * changes (TASK_SPECS §T8f).
 *
 * The contract is unchanged: a scenario still reaches the world over real HTTP
 * and still sees the endpoint's refusals (404, 403, 401, 400). Only `http:`
 * URLs take this path — anything else falls back to `fetch`, so `--url` against
 * a TLS endpoint keeps working.
 */

export interface LoopbackResponse {
  readonly status: number
  /** Parsed JSON body, or `null` when the body was empty or not JSON. */
  readonly body: unknown
}

/** Shared so a run reuses one socket instead of reconnecting per request. */
const agent = new http.Agent({ keepAlive: true })

export function isPlainHttpUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'http:'
  } catch {
    return false
  }
}

export async function requestJson(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string } = { method: 'GET' },
): Promise<LoopbackResponse> {
  if (!isPlainHttpUrl(url)) {
    const response = await fetch(url, {
      method: init.method,
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    const parsed: unknown = await response.json().catch(() => null)
    return { status: response.status, body: parsed }
  }

  const headers: Record<string, string> = { ...init.headers }
  if (init.body !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(init.body))
  }

  return new Promise<LoopbackResponse>((resolve, reject) => {
    const request = http.request(url, { method: init.method, agent, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        if (raw !== '') {
          try {
            body = JSON.parse(raw)
          } catch {
            body = null
          }
        }
        resolve({ status: response.statusCode ?? 0, body })
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end(init.body)
  })
}
