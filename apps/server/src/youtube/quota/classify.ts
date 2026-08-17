import type { FaultAction } from '../auth/errors.js'

/**
 * YouTube API error classification for T9/T10 (spec §11 fault matrix: "API
 * 403·429와 quota 고갈" each need a fixed expected state — `retry`, `degraded`
 * or `safe_stopped` — decided up front rather than per incident).
 *
 * Error shapes (checked 2026-08-17):
 * - REST: `{"error":{"code":403,"message":…,"errors":[{"reason":"quotaExceeded",
 *   "domain":"youtube.quota"}]}}`
 * - Live Streaming reference pages list the reasons used here:
 *   `rateLimitExceeded`/`userRequestsExceedRateLimit`
 *   (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert),
 *   `insufficientLivePermissions`, `liveStreamingNotEnabled`,
 *   `liveBroadcastNotFound`
 *   (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind),
 *   `concurrentBroadcastsExceedLimit`, `errorStreamInactive`
 *   (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition),
 *   `userBroadcastsExceedLimit`
 *   (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert)
 * - gRPC `streamList` maps to `PERMISSION_DENIED(7)`, `INVALID_ARGUMENT(3)`,
 *   `FAILED_PRECONDITION(9)`, `NOT_FOUND(5)`, `RESOURCE_EXHAUSTED(8)`
 *   (https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList)
 */

export type ApiErrorKind =
  /** Daily quota is gone; only the Pacific-midnight reset helps. */
  | 'quotaExceeded'
  /** Short-window rate limit; back off and retry. */
  | 'rateLimitExceeded'
  /** Access token rejected; refresh once, then treat as revoked. */
  | 'unauthorized'
  /** Scope/consent/permission problem a retry cannot fix. */
  | 'forbidden'
  /** The broadcast/chat is gone or ended: reconcile, do not retry blindly. */
  | 'notFound'
  /** The chat or broadcast is not in a state that allows the call. */
  | 'failedPrecondition'
  /** Channel-level live limits (`userBroadcastsExceedLimit`, `concurrentBroadcastsExceedLimit`). */
  | 'broadcastLimit'
  /** Malformed request — a bug on our side. */
  | 'invalidRequest'
  | 'serverError'
  | 'network'
  | 'unknown'

export interface ApiErrorClassification {
  readonly kind: ApiErrorKind
  readonly action: FaultAction
  readonly retryable: boolean
  /** Google's `reason` (REST) or gRPC status name, when present. */
  readonly reason?: string
  readonly httpStatus?: number
  readonly grpcCode?: number
  /** From a `Retry-After` header, when the response carried one. */
  readonly retryAfterMs?: number
  /** True when the caller should refresh the access token before retrying. */
  readonly refreshAuth?: boolean
}

export interface ApiErrorInput {
  readonly httpStatus?: number
  readonly grpcCode?: number
  /** Parsed response body, or the raw JSON string. */
  readonly body?: unknown
  readonly retryAfterHeader?: string | undefined
  /** Node error code for transport failures (`ECONNRESET`, …). */
  readonly errorCode?: string
  /**
   * Reference instant for an HTTP-date `Retry-After`. Callers pass
   * `Date.parse(clock.nowUtcIso())` so the classification stays deterministic
   * under an injected clock (spec §10.2).
   */
  readonly nowMs?: number
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded'])
const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'userRequestsExceedRateLimit',
])
const BROADCAST_LIMIT_REASONS = new Set([
  'userBroadcastsExceedLimit',
  'concurrentBroadcastsExceedLimit',
])
const FORBIDDEN_REASONS = new Set([
  'forbidden',
  'insufficientPermissions',
  'insufficientLivePermissions',
  'livePermissionBlocked',
  'liveStreamingNotEnabled',
])
const PRECONDITION_REASONS = new Set([
  'liveChatDisabled',
  'liveChatEnded',
  'errorStreamInactive',
  'invalidTransition',
  'redundantTransition',
])

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** gRPC status codes used by `liveChatMessages.streamList`. */
export const GRPC_CODES = Object.freeze({
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
})

const ACTION_BY_KIND: Readonly<Record<ApiErrorKind, FaultAction>> = {
  // The day's units are gone: keep the world running, stop calling YouTube.
  quotaExceeded: 'degraded',
  rateLimitExceeded: 'retry',
  unauthorized: 'retry',
  // Scope/consent problems need a human (spec §9.1).
  forbidden: 'safe_stopped',
  notFound: 'degraded',
  failedPrecondition: 'degraded',
  broadcastLimit: 'degraded',
  invalidRequest: 'degraded',
  serverError: 'retry',
  network: 'retry',
  unknown: 'degraded',
}

const RETRYABLE_KINDS: ReadonlySet<ApiErrorKind> = new Set<ApiErrorKind>([
  'rateLimitExceeded',
  'unauthorized',
  'serverError',
  'network',
])

export function classifyYouTubeApiError(input: ApiErrorInput): ApiErrorClassification {
  const reason = extractReason(input.body)
  const retryAfterMs = parseRetryAfter(input.retryAfterHeader, input.nowMs)

  const kind = detectKind(input, reason)
  return {
    kind,
    action: ACTION_BY_KIND[kind],
    retryable: RETRYABLE_KINDS.has(kind),
    ...(reason === undefined ? {} : { reason }),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.grpcCode === undefined ? {} : { grpcCode: input.grpcCode }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(kind === 'unauthorized' ? { refreshAuth: true } : {}),
  }
}

function detectKind(input: ApiErrorInput, reason: string | undefined): ApiErrorKind {
  if (input.errorCode !== undefined && NETWORK_CODES.has(input.errorCode)) {
    return 'network'
  }
  if (reason !== undefined) {
    if (QUOTA_REASONS.has(reason)) return 'quotaExceeded'
    if (RATE_REASONS.has(reason)) return 'rateLimitExceeded'
    if (BROADCAST_LIMIT_REASONS.has(reason)) return 'broadcastLimit'
    if (FORBIDDEN_REASONS.has(reason)) return 'forbidden'
    if (PRECONDITION_REASONS.has(reason)) return 'failedPrecondition'
    if (reason === 'authError' || reason === 'unauthorized') return 'unauthorized'
    if (reason === 'backendError' || reason === 'internalError') return 'serverError'
  }

  if (input.grpcCode !== undefined) {
    switch (input.grpcCode) {
      case GRPC_CODES.RESOURCE_EXHAUSTED:
        return 'rateLimitExceeded'
      case GRPC_CODES.PERMISSION_DENIED:
        return 'forbidden'
      case GRPC_CODES.UNAUTHENTICATED:
        return 'unauthorized'
      case GRPC_CODES.NOT_FOUND:
        return 'notFound'
      case GRPC_CODES.FAILED_PRECONDITION:
        return 'failedPrecondition'
      case GRPC_CODES.INVALID_ARGUMENT:
        return 'invalidRequest'
      case GRPC_CODES.UNAVAILABLE:
      case GRPC_CODES.DEADLINE_EXCEEDED:
      case GRPC_CODES.INTERNAL:
        return 'serverError'
      default:
        return 'unknown'
    }
  }

  switch (input.httpStatus) {
    case 400:
      return 'invalidRequest'
    case 401:
      return 'unauthorized'
    case 403:
      // 403 without a reason is ambiguous; treat as forbidden so the run stops
      // rather than hammering a call that is not allowed.
      return 'forbidden'
    case 404:
      return 'notFound'
    case 429:
      return 'rateLimitExceeded'
    default:
      break
  }
  if (input.httpStatus !== undefined && input.httpStatus >= 500) {
    return 'serverError'
  }
  return 'unknown'
}

function extractReason(body: unknown): string | undefined {
  const parsed = typeof body === 'string' ? tryParse(body) : body
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined
  }
  const error = (parsed as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  const errors = (error as { errors?: unknown }).errors
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const reason = (entry as { reason?: unknown } | null)?.reason
      if (typeof reason === 'string' && reason !== '') {
        return reason
      }
    }
  }
  const status = (error as { status?: unknown }).status
  return typeof status === 'string' ? status : undefined
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `Retry-After` is either seconds or an HTTP date (RFC 9110). */
function parseRetryAfter(header: string | undefined, nowMs?: number): number | undefined {
  if (header === undefined || header === '') {
    return undefined
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }
  const dateMs = Date.parse(header)
  if (Number.isNaN(dateMs)) {
    return undefined
  }
  return Math.max(0, dateMs - (nowMs ?? Date.now()))
}
