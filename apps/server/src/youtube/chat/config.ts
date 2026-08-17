import {
  AuthConfigError,
  asObject,
  readPositiveInt,
  readString,
  readStringArray,
  readYouTubeSection,
  type LoadAuthConfigOptions,
} from '../auth/config.js'

/**
 * `youtube.chat` from `config/default.json` (TASK_SPECS 공통 규약: config file +
 * env override, secrets never here).
 *
 * Two values are documented facts and two dozen are not, so the `provisional`
 * list is part of the contract (BOARD A-15): the endpoint and `maxResults`
 * default come from the official pages, everything about reconnect pacing and
 * fallback policy is a first guess to be replaced with the Gate 2 numbers.
 *
 * `parts` is validated rather than merely read. While the identity gate is
 * closed (BOARD A-1) the only requestable parts are `id` and `snippet`; asking
 * for `authorDetails` would pull display names and channel ids across the
 * process boundary, which spec §7.2/§7.4 forbid outright. A typo in a config
 * file must not be able to do that, so the loader refuses to start.
 */

/** The only parts V1 may request (spec §7.2). */
export const ALLOWED_PARTS = ['id', 'snippet'] as const
/** Requestable but forbidden while the identity gate is closed (BOARD A-1). */
export const IDENTITY_PART = 'authorDetails'

export class ChatConfigError extends Error {
  constructor(message: string) {
    super(`invalid youtube chat config: ${message}`)
    this.name = 'ChatConfigError'
  }
}

export interface ChatKeepaliveConfig {
  /** `grpc.keepalive_time_ms` — interval between HTTP/2 PING frames. */
  readonly timeMs: number
  /** `grpc.keepalive_timeout_ms` — how long a PING may go unacknowledged. */
  readonly timeoutMs: number
  /** `grpc.keepalive_permit_without_calls`. */
  readonly permitWithoutCalls: boolean
}

export interface ChatGrpcConfig {
  /** `host:port`; the `dns:///` scheme is added by the transport. */
  readonly endpoint: string
  readonly keepalive: ChatKeepaliveConfig
}

export interface ChatRestConfig {
  readonly baseUrl: string
  /** Floor for a poll interval, including when the server names none. */
  readonly minPollIntervalMs: number
  /** Ceiling, so a nonsense server value cannot stall ingestion for an hour. */
  readonly maxPollIntervalMs: number
  readonly requestTimeoutMs: number
}

export interface ChatReconnectConfig {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly factor: number
  readonly jitterRatio: number
  /**
   * Retries after which the source reports `degraded` instead of `retry`. It is
   * **not** a give-up count: a chat source that stopped trying would end
   * unattended operation (spec §2.1). Past this budget the source keeps
   * reconnecting at `maxDelayMs` and says so on `/health` (T12 decides).
   */
  readonly maxAttempts: number
}

export interface ChatFallbackConfig {
  /** Consecutive gRPC failures before the REST poller takes over (spec §4). */
  readonly enterAfterConsecutiveFailures: number
  /** How long to stay on REST before trying the low-latency path again. */
  readonly retryPrimaryAfterMs: number
}

export interface ChatConfig {
  /** Master switch; the source stays inert until an operator turns it on. */
  readonly enabled: boolean
  /** `liveChatId` when it is injected by config; `null` means "ask the resolver". */
  readonly liveChatId: string | null
  /** Broadcast the chat belongs to; part of every `eventKey` (spec §7.4). */
  readonly broadcastId: string | null
  readonly parts: readonly string[]
  readonly maxResults: number
  readonly grpc: ChatGrpcConfig
  readonly rest: ChatRestConfig
  readonly reconnect: ChatReconnectConfig
  readonly fallback: ChatFallbackConfig
  /** How often the source re-asks the engine whether it may start (spec §7.3(3)). */
  readonly readyPollIntervalMs: number
  readonly provisional: readonly string[]
}

export function loadChatConfig(options: LoadAuthConfigOptions = {}): ChatConfig {
  const section = readYouTubeSection('chat', options)
  const env = options.env ?? process.env

  const grpc = asObject(section['grpc'], 'youtube.chat.grpc')
  const keepalive = asObject(grpc['keepalive'], 'youtube.chat.grpc.keepalive')
  const rest = asObject(section['rest'], 'youtube.chat.rest')
  const reconnect = asObject(section['reconnect'], 'youtube.chat.reconnect')
  const fallback = asObject(section['fallback'], 'youtube.chat.fallback')

  const parts = readParts(section['parts'])
  const minPollIntervalMs = readPositiveInt(
    rest['minPollIntervalMs'],
    'youtube.chat.rest.minPollIntervalMs',
  )
  const maxPollIntervalMs = readPositiveInt(
    rest['maxPollIntervalMs'],
    'youtube.chat.rest.maxPollIntervalMs',
  )
  if (maxPollIntervalMs < minPollIntervalMs) {
    throw new ChatConfigError('rest.maxPollIntervalMs must be >= rest.minPollIntervalMs')
  }
  const initialDelayMs = readPositiveInt(
    reconnect['initialDelayMs'],
    'youtube.chat.reconnect.initialDelayMs',
  )
  const maxDelayMs = readPositiveInt(reconnect['maxDelayMs'], 'youtube.chat.reconnect.maxDelayMs')
  if (maxDelayMs < initialDelayMs) {
    throw new ChatConfigError('reconnect.maxDelayMs must be >= reconnect.initialDelayMs')
  }
  const maxResults = readPositiveInt(section['maxResults'], 'youtube.chat.maxResults')
  // "Acceptable values are 200 to 2000, inclusive" — liveChatMessages.streamList
  // and .list reference pages, checked 2026-08-17.
  if (maxResults < 200 || maxResults > 2000) {
    throw new ChatConfigError(`maxResults must be between 200 and 2000, got ${maxResults}`)
  }

  return Object.freeze({
    enabled: readBoolean(section['enabled'], 'youtube.chat.enabled'),
    liveChatId: readNullableString(
      env['VL_YOUTUBE_LIVE_CHAT_ID'] ?? section['liveChatId'],
      'youtube.chat.liveChatId',
    ),
    broadcastId: readNullableString(
      env['VL_YOUTUBE_BROADCAST_ID'] ?? section['broadcastId'],
      'youtube.chat.broadcastId',
    ),
    parts: Object.freeze(parts),
    maxResults,
    grpc: Object.freeze({
      endpoint: readString(grpc['endpoint'], 'youtube.chat.grpc.endpoint'),
      keepalive: Object.freeze({
        timeMs: readPositiveInt(keepalive['timeMs'], 'youtube.chat.grpc.keepalive.timeMs'),
        timeoutMs: readPositiveInt(keepalive['timeoutMs'], 'youtube.chat.grpc.keepalive.timeoutMs'),
        permitWithoutCalls: readBoolean(
          keepalive['permitWithoutCalls'],
          'youtube.chat.grpc.keepalive.permitWithoutCalls',
        ),
      }),
    }),
    rest: Object.freeze({
      baseUrl: readString(rest['baseUrl'], 'youtube.chat.rest.baseUrl'),
      minPollIntervalMs,
      maxPollIntervalMs,
      requestTimeoutMs: readPositiveInt(
        rest['requestTimeoutMs'],
        'youtube.chat.rest.requestTimeoutMs',
      ),
    }),
    reconnect: Object.freeze({
      initialDelayMs,
      maxDelayMs,
      factor: readPositiveNumber(reconnect['factor'], 'youtube.chat.reconnect.factor'),
      jitterRatio: readRatio(reconnect['jitterRatio'], 'youtube.chat.reconnect.jitterRatio'),
      maxAttempts: readPositiveInt(reconnect['maxAttempts'], 'youtube.chat.reconnect.maxAttempts'),
    }),
    fallback: Object.freeze({
      enterAfterConsecutiveFailures: readPositiveInt(
        fallback['enterAfterConsecutiveFailures'],
        'youtube.chat.fallback.enterAfterConsecutiveFailures',
      ),
      retryPrimaryAfterMs: readPositiveInt(
        fallback['retryPrimaryAfterMs'],
        'youtube.chat.fallback.retryPrimaryAfterMs',
      ),
    }),
    readyPollIntervalMs: readPositiveInt(
      section['readyPollIntervalMs'],
      'youtube.chat.readyPollIntervalMs',
    ),
    provisional: Object.freeze(readStringArray(section['provisional'], 'youtube.chat.provisional')),
  })
}

function readParts(value: unknown): string[] {
  const parts = readStringArray(value, 'youtube.chat.parts')
  if (parts.length === 0) {
    throw new ChatConfigError('parts must not be empty')
  }
  if (parts.includes(IDENTITY_PART)) {
    throw new ChatConfigError(
      `parts must not contain ${IDENTITY_PART}: the identity gate is closed in V1, so no author identity may be requested (spec §7.2, §7.4, BOARD A-1)`,
    )
  }
  const unknown = parts.filter(
    (part) => !ALLOWED_PARTS.includes(part as (typeof ALLOWED_PARTS)[number]),
  )
  if (unknown.length > 0) {
    throw new ChatConfigError(`parts contains unsupported value(s): ${unknown.join(', ')}`)
  }
  return parts
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AuthConfigError(`${label} must be a boolean`)
  }
  return value
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new AuthConfigError(`${label} must be a string or null`)
  }
  return value
}

function readPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AuthConfigError(`${label} must be a positive number`)
  }
  return value
}

function readRatio(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AuthConfigError(`${label} must be between 0 and 1`)
  }
  return value
}
