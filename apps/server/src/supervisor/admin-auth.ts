import { timingSafeEqual } from 'node:crypto'

import { isLoopbackAddress } from '../engine/ingest.js'

/**
 * The admission rules every `POST /admin/*` route shares: **loopback and** a
 * bearer `server.adminToken` (spec §10.2).
 *
 * It lives on its own so the moderation report path of §12.3 is admitted by the
 * same code as the kill switch rather than by a second, subtly different copy
 * of it — a constant-time comparison written twice is a comparison that can
 * stop being constant-time in one place (TASK_SPECS §T22: "kill-switch와 동일
 * 인증/거부 규칙").
 */

export interface AdminRequest {
  readonly authorization: string | null
  readonly remoteAddress: string | null
  readonly body: unknown
}

export interface AdminResponse {
  readonly status: number
  readonly body: Record<string, unknown>
}

/**
 * `null` when the request may proceed, otherwise the refusal to send back.
 *
 * The two refusals are distinct on purpose: an operator whose request came from
 * the wrong interface and one whose token is wrong have different problems, and
 * neither response says anything about the other's secret.
 */
export function authorizeAdmin(request: AdminRequest, token: string | null): AdminResponse | null {
  if (!isLoopbackAddress(request.remoteAddress)) {
    return { status: 403, body: { error: 'loopback_only' } }
  }
  if (!bearerMatches(request.authorization, token)) {
    return { status: 401, body: { error: 'unauthorized' } }
  }
  return null
}

function bearerMatches(authorization: string | null, expected: string | null): boolean {
  // No token configured is a closed door, not an open one.
  if (expected === null || expected === '') return false
  const prefix = 'Bearer '
  if (authorization === null || !authorization.startsWith(prefix)) return false
  const presented = Buffer.from(authorization.slice(prefix.length))
  const secret = Buffer.from(expected)
  if (presented.length !== secret.length) return false
  return timingSafeEqual(presented, secret)
}

/**
 * A bounded, printable machine token taken from an operator-supplied field.
 *
 * Operator text is not echoed into the world: what reaches an alert, `/health`
 * or a log line is at most `maxLength` characters of letters, digits and a few
 * separators — never punctuation a chat line could ride in on (§12.3).
 */
export function readTokenField(body: unknown, field: string, maxLength = 120): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const value = (body as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value === '') return null
  return value.slice(0, maxLength).replace(/[^\p{L}\p{N} ._:-]/gu, '')
}
