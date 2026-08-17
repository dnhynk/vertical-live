/**
 * OAuth failure classification. The token endpoint answers with an RFC 6749
 * error code in the body; the product needs to tell three things apart:
 * "retry later", "the operator has to log in again" and "the request itself is
 * wrong". Spec §11's fault matrix rows (OAuth access-token 만료, refresh-token
 * 철회) map onto `retry` / `degraded` / `safe_stopped` through `faultAction`.
 *
 * Source (checked 2026-08-17):
 * https://developers.google.com/identity/protocols/oauth2/native-app —
 * `invalid_grant` (code verifier missing/invalid, token expired or revoked),
 * `access_denied` (user declined), `redirect_uri_mismatch`.
 * https://developers.google.com/identity/protocols/oauth2 — a revoked, expired
 * (7-day testing-status, 6-month unused) or limit-evicted refresh token fails
 * with `invalid_grant`.
 */

export type OAuthFailureKind =
  /** Refresh token no longer usable: revoked, expired, or superseded. Needs a human re-consent. */
  | 'revoked'
  /** The operator declined consent in the browser. */
  | 'user_denied'
  /** Client id/secret rejected — configuration error, retrying cannot help. */
  | 'invalid_client'
  /** Malformed request, unknown scope, redirect mismatch — code/config error. */
  | 'invalid_request'
  /** 429 / slow_down — retry with backoff. */
  | 'rate_limited'
  /** 5xx from the token endpoint — retry with backoff. */
  | 'server'
  /** DNS/connect/socket failure — retry with backoff. */
  | 'network'
  | 'unknown'

/** Expected supervisor state for this failure (spec §11 fault matrix). */
export type FaultAction = 'retry' | 'degraded' | 'safe_stopped'

export interface OAuthFailure {
  readonly kind: OAuthFailureKind
  /** RFC 6749 `error` value when the endpoint returned one. */
  readonly oauthError?: string
  /** `error_description`. Never contains a token value; still redacted before logging. */
  readonly description?: string
  readonly httpStatus?: number
  readonly retryable: boolean
  readonly faultAction: FaultAction
}

export class OAuthRequestError extends Error {
  readonly failure: OAuthFailure

  constructor(message: string, failure: OAuthFailure) {
    super(message)
    this.name = 'OAuthRequestError'
    this.failure = failure
  }
}

const KIND_BY_OAUTH_ERROR: Readonly<Record<string, OAuthFailureKind>> = {
  invalid_grant: 'revoked',
  access_denied: 'user_denied',
  invalid_client: 'invalid_client',
  unauthorized_client: 'invalid_client',
  invalid_request: 'invalid_request',
  invalid_scope: 'invalid_request',
  redirect_uri_mismatch: 'invalid_request',
  unsupported_grant_type: 'invalid_request',
  slow_down: 'rate_limited',
  rate_limit_exceeded: 'rate_limited',
  temporarily_unavailable: 'server',
  server_error: 'server',
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

const RETRYABLE: ReadonlySet<OAuthFailureKind> = new Set<OAuthFailureKind>([
  'rate_limited',
  'server',
  'network',
])

/**
 * `revoked` and `user_denied` are `safe_stopped`: re-consent is a human step
 * (spec §9.1 lists "만료된 사람의 재동의" outside the automation boundary), so
 * the supervisor must stop and alert instead of looping.
 */
function faultActionFor(kind: OAuthFailureKind): FaultAction {
  switch (kind) {
    case 'revoked':
    case 'user_denied':
    case 'invalid_client':
      return 'safe_stopped'
    case 'invalid_request':
    case 'unknown':
      return 'degraded'
    default:
      return 'retry'
  }
}

function makeFailure(
  kind: OAuthFailureKind,
  parts: { oauthError?: string; description?: string; httpStatus?: number },
): OAuthFailure {
  return {
    kind,
    ...(parts.oauthError === undefined ? {} : { oauthError: parts.oauthError }),
    ...(parts.description === undefined ? {} : { description: parts.description }),
    ...(parts.httpStatus === undefined ? {} : { httpStatus: parts.httpStatus }),
    retryable: RETRYABLE.has(kind),
    faultAction: faultActionFor(kind),
  }
}

/** Classifies an OAuth error body (`{error, error_description}`) plus HTTP status. */
export function classifyOAuthErrorBody(
  body: { error?: unknown; error_description?: unknown } | undefined,
  httpStatus?: number,
): OAuthFailure {
  const oauthError = typeof body?.error === 'string' ? body.error : undefined
  const description =
    typeof body?.error_description === 'string' ? body.error_description : undefined

  if (oauthError !== undefined && KIND_BY_OAUTH_ERROR[oauthError] !== undefined) {
    const kind = KIND_BY_OAUTH_ERROR[oauthError] as OAuthFailureKind
    return makeFailure(kind, { oauthError, description, ...(httpStatus ? { httpStatus } : {}) })
  }
  if (httpStatus === 429) {
    return makeFailure('rate_limited', { oauthError, description, httpStatus })
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return makeFailure('server', { oauthError, description, httpStatus })
  }
  return makeFailure('unknown', {
    ...(oauthError === undefined ? {} : { oauthError }),
    ...(description === undefined ? {} : { description }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  })
}

/**
 * Classifies whatever the auth library throws. `google-auth-library` surfaces
 * token-endpoint failures as gaxios errors (`response.data` holds the RFC 6749
 * body) but also plain `Error`s whose message carries the code, so both shapes
 * are inspected before falling back to `unknown`.
 */
export function classifyOAuthError(error: unknown): OAuthFailure {
  if (error instanceof OAuthRequestError) {
    return error.failure
  }

  const candidate = error as {
    code?: unknown
    status?: unknown
    message?: unknown
    response?: { status?: unknown; data?: unknown }
  } | null

  const code = typeof candidate?.code === 'string' ? candidate.code : undefined
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return makeFailure('network', { description: stringOrUndefined(candidate?.message) })
  }

  const httpStatus = numberOrUndefined(candidate?.response?.status) ?? numberOrUndefined(candidate?.status)
  const data = candidate?.response?.data
  const body = parseErrorBody(data)
  if (body !== undefined) {
    return classifyOAuthErrorBody(body, httpStatus)
  }

  // Last resort: the library sometimes only preserves the code in the message.
  const message = stringOrUndefined(candidate?.message) ?? ''
  for (const [oauthError, kind] of Object.entries(KIND_BY_OAUTH_ERROR)) {
    if (message.includes(oauthError)) {
      return makeFailure(kind, {
        oauthError,
        description: message,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      })
    }
  }
  return classifyOAuthErrorBody(undefined, httpStatus)
}

function parseErrorBody(
  data: unknown,
): { error?: unknown; error_description?: unknown } | undefined {
  if (typeof data === 'object' && data !== null) {
    return data as { error?: unknown; error_description?: unknown }
  }
  if (typeof data === 'string' && data.trimStart().startsWith('{')) {
    try {
      return JSON.parse(data) as { error?: unknown; error_description?: unknown }
    } catch {
      return undefined
    }
  }
  return undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** True when the failure means "no usable grant any more" (drives `AuthRevoked`). */
export function isRevocation(failure: OAuthFailure): boolean {
  return failure.kind === 'revoked'
}
