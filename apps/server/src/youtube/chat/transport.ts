import { fileURLToPath } from 'node:url'

import {
  ChannelCredentials,
  Client,
  Metadata,
  type ChannelOptions,
  type ClientReadableStream,
  type ServiceError,
  loadPackageDefinition,
} from '@grpc/grpc-js'
import { loadSync, type Options as ProtoLoaderOptions } from '@grpc/proto-loader'

import type { ChatKeepaliveConfig } from './config.js'

/**
 * gRPC transport for `liveChatMessages.streamList` ([S4]).
 *
 * The wire contract is `apps/server/proto/stream_list.proto`, copied from the
 * Streaming Live Chat guide. Nothing here interprets a message: the transport
 * hands raw response objects to `grpc-source.ts`, which passes their `items`
 * to the `@vl/contract` adapter. That separation is what keeps the "gRPC and
 * REST field names are never mixed" rule of spec §7.2 mechanical.
 *
 * Loader options are the ones TASK-T1 documented as the adapter's premise:
 * `keepCase` so field names stay snake_case exactly as the proto writes them,
 * `enums: String` so a type reads as `SUPER_CHAT_EVENT` rather than `15`,
 * `longs: String` so `amount_micros` survives past 2^53, and `defaults: false`
 * so an absent field stays absent instead of arriving as `""`/`0` — the adapter
 * distinguishes the two.
 */

export const STREAM_LIST_PROTO_PATH = fileURLToPath(
  new URL('../../../proto/stream_list.proto', import.meta.url),
)

export const STREAM_LIST_SERVICE = 'youtube.api.v3.V3DataLiveChatMessageService'

export const PROTO_LOADER_OPTIONS: ProtoLoaderOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true,
}

/** Request fields of `LiveChatMessageListRequest`, snake_case as in the proto. */
export interface StreamListRequest {
  readonly live_chat_id: string
  readonly part: readonly string[]
  readonly max_results?: number
  readonly page_token?: string
}

/** What one server response carries, as far as the source cares. */
export interface StreamListResponse {
  readonly items?: readonly unknown[]
  readonly next_page_token?: string
  readonly offline_at?: string
}

/** Subscription handle: the events `grpc-source.ts` reacts to, and a cancel. */
export interface StreamListCall {
  onData(handler: (response: StreamListResponse) => void): void
  onError(handler: (error: ServiceError) => void): void
  onEnd(handler: () => void): void
  cancel(): void
}

export interface StreamListTransport {
  /** Opens one server-streaming call authorized with this access token. */
  open(request: StreamListRequest, accessToken: string): StreamListCall
  /**
   * Channel connectivity as gRPC reports it (`IDLE`, `CONNECTING`, `READY`,
   * `TRANSIENT_FAILURE`, `SHUTDOWN`) — the only keepalive-adjacent state the
   * library exposes to a client (spec §9.4(3)).
   */
  channelState(): string
  close(): void
}

export interface GrpcTransportOptions {
  /** `host:port`; `dns:///` is added here, matching the official demo. */
  readonly endpoint: string
  readonly keepalive: ChatKeepaliveConfig
  /** TLS by default; tests against the fake server pass insecure credentials. */
  readonly credentials?: ChannelCredentials
  readonly protoPath?: string
}

/** Names of the connectivity states, indexed by `ConnectivityState`. */
const CONNECTIVITY_STATE_NAMES = [
  'IDLE',
  'CONNECTING',
  'READY',
  'TRANSIENT_FAILURE',
  'SHUTDOWN',
] as const

interface StreamListClient extends Client {
  StreamList(
    request: StreamListRequest,
    metadata: Metadata,
  ): ClientReadableStream<StreamListResponse>
}

type StreamListClientConstructor = new (
  address: string,
  credentials: ChannelCredentials,
  options: Partial<ChannelOptions>,
) => StreamListClient

/** Loads the proto and returns the generated client constructor. */
export function loadStreamListClientClass(
  protoPath: string = STREAM_LIST_PROTO_PATH,
): StreamListClientConstructor {
  const definition = loadSync(protoPath, PROTO_LOADER_OPTIONS)
  const pkg = loadPackageDefinition(definition)
  const service = resolvePath(pkg, STREAM_LIST_SERVICE)
  if (typeof service !== 'function') {
    throw new Error(`${STREAM_LIST_SERVICE} is not a service in ${protoPath}`)
  }
  return service as unknown as StreamListClientConstructor
}

export class GrpcStreamListTransport implements StreamListTransport {
  readonly #client: StreamListClient

  constructor(options: GrpcTransportOptions) {
    const ClientClass = loadStreamListClientClass(options.protoPath)
    this.#client = new ClientClass(
      `dns:///${options.endpoint}`,
      options.credentials ?? ChannelCredentials.createSsl(),
      {
        'grpc.keepalive_time_ms': options.keepalive.timeMs,
        'grpc.keepalive_timeout_ms': options.keepalive.timeoutMs,
        'grpc.keepalive_permit_without_calls': options.keepalive.permitWithoutCalls ? 1 : 0,
      },
    )
  }

  open(request: StreamListRequest, accessToken: string): StreamListCall {
    const metadata = new Metadata()
    // The guide's demo sends exactly this header ("authorization", "Bearer " +
    // token). The value never reaches a log: only the transport holds it.
    metadata.set('authorization', `Bearer ${accessToken}`)
    const stream = this.#client.StreamList(request, metadata)
    return {
      onData: (handler) => stream.on('data', handler),
      onError: (handler) => stream.on('error', handler),
      onEnd: (handler) => stream.on('end', handler),
      cancel: () => {
        stream.cancel()
      },
    }
  }

  channelState(): string {
    const state = this.#client.getChannel().getConnectivityState(false)
    return CONNECTIVITY_STATE_NAMES[state] ?? `UNKNOWN(${state})`
  }

  close(): void {
    this.#client.close()
  }
}

function resolvePath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (typeof node !== 'object' || node === null) return undefined
    return (node as Record<string, unknown>)[segment]
  }, root)
}
