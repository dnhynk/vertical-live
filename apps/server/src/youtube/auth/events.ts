import type { OAuthFailureKind } from './errors.js'

/**
 * Auth lifecycle events. `auth_revoked` is the hook spec §9.1/§12.4 need: T12
 * turns it into an alert and a `safe_stopped` transition, T13 uses it as the
 * trigger to delete data collected under the withdrawn consent.
 *
 * No event carries a token, a channel id or an author name — events are meant
 * to be logged, alerted and persisted (§10.2, §12.4, A-1).
 */

export type AuthRevokedReason =
  /** Token endpoint answered `invalid_grant`: revoked, expired or superseded. */
  | 'invalid_grant'
  /** The vault holds no refresh token, so there is nothing to refresh. */
  | 'missing_refresh_token'
  /** The operator revoked the grant through the CLI. */
  | 'operator_revoked'

interface AuthEventBase {
  /** Absolute UTC ISO 8601 instant (spec §10.2). */
  readonly at: string
}

export interface AuthLoginCompletedEvent extends AuthEventBase {
  readonly type: 'auth_login_completed'
  readonly grantedScopes: readonly string[]
  readonly accessTokenExpiresAt: string
}

export interface AuthTokenRefreshedEvent extends AuthEventBase {
  readonly type: 'auth_token_refreshed'
  readonly accessTokenExpiresAt: string
}

export interface AuthRefreshTokenRotatedEvent extends AuthEventBase {
  readonly type: 'auth_refresh_token_rotated'
}

export interface AuthRefreshFailedEvent extends AuthEventBase {
  readonly type: 'auth_refresh_failed'
  readonly kind: OAuthFailureKind
  readonly retryable: boolean
  /** Redacted description, safe to log and alert. */
  readonly detail?: string
}

export interface AuthRevokedEvent extends AuthEventBase {
  readonly type: 'auth_revoked'
  readonly reason: AuthRevokedReason
  /** Redacted description, safe to log and alert. */
  readonly detail?: string
}

export type AuthEvent =
  | AuthLoginCompletedEvent
  | AuthTokenRefreshedEvent
  | AuthRefreshTokenRotatedEvent
  | AuthRefreshFailedEvent
  | AuthRevokedEvent

export interface AuthEventSink {
  emit(event: AuthEvent): void
}

/** Sink that drops events; default when a caller does not wire T12 in yet. */
export const nullAuthEventSink: AuthEventSink = { emit: () => {} }

/** Sink that keeps events in order — used by tests and the login CLI's summary. */
export class RecordingAuthEventSink implements AuthEventSink {
  readonly events: AuthEvent[] = []

  emit(event: AuthEvent): void {
    this.events.push(event)
  }

  ofType<T extends AuthEvent['type']>(type: T): Extract<AuthEvent, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<AuthEvent, { type: T }> => event.type === type,
    )
  }
}
