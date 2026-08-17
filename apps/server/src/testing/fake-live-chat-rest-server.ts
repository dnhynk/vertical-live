import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A loopback stand-in for `GET /youtube/v3/liveChat/messages` ([S3]), used by
 * the REST fallback tests of TASK_SPECS §T9.
 *
 * Like the gRPC fake it records what actually arrived — query parameters and
 * whether a bearer header was present — so "the fallback never asks for
 * `authorDetails` either" is proved from the wire, not from the caller's
 * intentions. Bodies are obviously synthetic (spec §2.6).
 */

export interface RecordedRestRequest {
  readonly liveChatId: string | null
  readonly parts: readonly string[]
  readonly maxResults: string | null
  readonly pageToken: string | null
  readonly authorized: boolean
}

export interface FakeRestStep {
  readonly status?: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

export class FakeLiveChatRestServer {
  readonly #server: Server
  readonly #script: readonly FakeRestStep[]
  readonly #requests: RecordedRestRequest[] = []
  #calls = 0

  private constructor(server: Server, script: readonly FakeRestStep[]) {
    this.#server = server
    this.#script = script
  }

  static async start(script: readonly FakeRestStep[]): Promise<FakeLiveChatRestServer> {
    const server = createServer()
    const fake = new FakeLiveChatRestServer(server, script)
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const part = url.searchParams.get('part')
      fake.#requests.push({
        liveChatId: url.searchParams.get('liveChatId'),
        parts: part === null ? [] : part.split(','),
        maxResults: url.searchParams.get('maxResults'),
        pageToken: url.searchParams.get('pageToken'),
        authorized: (request.headers.authorization ?? '').startsWith('Bearer '),
      })
      const index = Math.min(fake.#calls, fake.#script.length - 1)
      fake.#calls += 1
      const step = fake.#script[index] ?? {}
      response.writeHead(step.status ?? 200, {
        'content-type': 'application/json',
        ...(step.headers ?? {}),
      })
      response.end(JSON.stringify(step.body ?? {}))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    return fake
  }

  get baseUrl(): string {
    const address = this.#server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}/youtube/v3/liveChat/messages`
  }

  get requests(): readonly RecordedRestRequest[] {
    return this.#requests
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve()
      })
      this.#server.closeAllConnections()
    })
  }
}
