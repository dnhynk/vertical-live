import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
  type ServerWritableStream,
  type UntypedServiceImplementation,
} from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'

import {
  PROTO_LOADER_OPTIONS,
  STREAM_LIST_PROTO_PATH,
  STREAM_LIST_SERVICE,
} from '../youtube/chat/transport.js'

/**
 * A real gRPC server speaking the copied `stream_list.proto`, for the tests
 * TASK_SPECS §T9 acceptance 1 asks for (stream, resume, mid-stream break,
 * poison item, fallback) and acceptance 2 (`authorDetails` is never requested).
 *
 * It is a fake, not a mock: the client under test dials it over a real HTTP/2
 * connection with the real generated stubs, so the request it records is what
 * actually went on the wire — which is the only way an "we never ask for
 * `authorDetails`" test proves anything.
 *
 * Every value it serves is obviously synthetic (`UC_TEST_…`, `msg_test_…`), as
 * spec §2.6 requires of fixtures.
 */

export interface RecordedStreamListRequest {
  readonly liveChatId: string | undefined
  readonly parts: readonly string[]
  readonly maxResults: number | undefined
  readonly pageToken: string | undefined
  /** Whether an `authorization: Bearer …` header arrived (value never stored). */
  readonly authorized: boolean
}

/** How one connection behaves. The last entry repeats for later connections. */
export interface FakeConnectionScript {
  /** Responses written before the call ends. */
  readonly responses?: readonly Record<string, unknown>[]
  /**
   * - `complete`: the server closes the stream cleanly.
   * - `hang`: the stream stays open (the test drives what happens next).
   * - `{errorCode}`: the call fails with that gRPC status.
   */
  readonly end?: 'complete' | 'hang' | { readonly errorCode: number; readonly details?: string }
}

export interface FakeStreamListServerOptions {
  readonly script: readonly FakeConnectionScript[]
}

export class FakeStreamListServer {
  readonly #server: Server
  readonly #script: readonly FakeConnectionScript[]
  readonly #requests: RecordedStreamListRequest[] = []
  readonly #open = new Set<ServerWritableStream<Record<string, unknown>, unknown>>()
  #port = 0
  #connections = 0

  private constructor(server: Server, script: readonly FakeConnectionScript[]) {
    this.#server = server
    this.#script = script
  }

  static async start(options: FakeStreamListServerOptions): Promise<FakeStreamListServer> {
    const definition = loadSync(STREAM_LIST_PROTO_PATH, PROTO_LOADER_OPTIONS)
    const pkg = loadPackageDefinition(definition) as unknown as Record<string, unknown>
    const service = servicePath(pkg)
    const server = new Server()
    const fake = new FakeStreamListServer(server, options.script)

    const implementation: UntypedServiceImplementation = {
      StreamList: (call: ServerWritableStream<Record<string, unknown>, unknown>) => {
        fake.#handle(call)
      },
    }
    server.addService(service, implementation)

    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, bound) => {
        if (error !== null) reject(error)
        else resolve(bound)
      })
    })
    fake.#port = port
    return fake
  }

  get endpoint(): string {
    return `127.0.0.1:${this.#port}`
  }

  /** Every request the server actually received, in order. */
  get requests(): readonly RecordedStreamListRequest[] {
    return this.#requests
  }

  get connectionCount(): number {
    return this.#connections
  }

  stop(): Promise<void> {
    // `forceShutdown`, not `tryShutdown`: a `hang` script leaves a call open on
    // purpose, and a graceful shutdown would wait for it forever.
    for (const call of this.#open) call.end()
    this.#open.clear()
    this.#server.forceShutdown()
    return Promise.resolve()
  }

  #handle(call: ServerWritableStream<Record<string, unknown>, unknown>): void {
    const request = call.request
    const parts = Array.isArray(request['part']) ? (request['part'] as string[]) : []
    this.#requests.push({
      liveChatId: asString(request['live_chat_id']),
      parts,
      maxResults: asNumber(request['max_results']),
      pageToken: asString(request['page_token']),
      authorized: (call.metadata.get('authorization')[0] ?? '').toString().startsWith('Bearer '),
    })

    const index = Math.min(this.#connections, this.#script.length - 1)
    this.#connections += 1
    const step = this.#script[index] ?? { end: 'complete' as const }

    for (const response of step.responses ?? []) call.write(response)

    const end = step.end ?? 'complete'
    if (end === 'hang') {
      this.#open.add(call)
      call.on('close', () => this.#open.delete(call))
      return
    }
    if (end === 'complete') {
      call.end()
      return
    }
    call.emit('error', {
      code: end.errorCode,
      details: end.details ?? 'fake stream_list failure',
    })
  }
}

function servicePath(pkg: Record<string, unknown>): Parameters<Server['addService']>[0] {
  const node = STREAM_LIST_SERVICE.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null) return undefined
    return (current as Record<string, unknown>)[segment]
  }, pkg)
  const definition = (node as { service?: unknown } | undefined)?.service
  if (definition === undefined) {
    throw new Error(`${STREAM_LIST_SERVICE} not found in the loaded proto`)
  }
  return definition as Parameters<Server['addService']>[0]
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
