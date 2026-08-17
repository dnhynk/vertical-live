import type { Clock } from '../../clock.js'
import { SecretRedactor, silentLogger, type Logger } from '../../secrets/redaction.js'
import type { SecretName, SecretVault } from '../../secrets/index.js'
import { nullAuthEventSink, type AuthEventSink, type AuthRevokedReason } from './events.js'
import { classifyOAuthError, isRevocation, OAuthRequestError, type OAuthFailure } from './errors.js'
import type { OAuthClient, TokenSet } from './oauth-client.js'

/**
 * Keeps a usable access token available and owns the refresh token's lifetime
 * (spec §10.2: "access-token 갱신, refresh-token rotation, 철회·재동의 절차를
 * 시험한다").
 *
 * Rules this class encodes:
 * - the refresh token only ever lives in the vault; the access token only ever
 *   lives in memory, so a crash cannot leave it on disk
 * - a rotated refresh token replaces the stored one before the new access token
 *   is handed out, so a crash mid-rotation cannot strand the grant
 * - `invalid_grant` stops the loop: the manager latches into `revoked`, emits
 *   `auth_revoked` once and refuses further refreshes until someone logs in
 *   again (spec §9.1 puts re-consent outside the automation boundary)
 */

export const REFRESH_TOKEN_SECRET: SecretName = 'youtube.oauthRefreshToken'

export type TokenManagerState = 'ready' | 'revoked'

export interface TokenManagerOptions {
  readonly client: OAuthClient
  readonly vault: SecretVault
  readonly clock: Clock
  /** Refresh this long before expiry. */
  readonly refreshSkewMs: number
  readonly events?: AuthEventSink
  readonly logger?: Logger
  /** Shared redactor so token values stay out of every logger downstream. */
  readonly redactor?: SecretRedactor
}

export class AuthRevokedError extends Error {
  readonly reason: AuthRevokedReason

  constructor(reason: AuthRevokedReason, detail?: string) {
    super(
      `youtube grant is no longer usable (${reason}); run "npm run auth:login -w @vl/server"${
        detail === undefined ? '' : ` — ${detail}`
      }`,
    )
    this.name = 'AuthRevokedError'
    this.reason = reason
  }
}

export class TokenManager {
  readonly #client: OAuthClient
  readonly #vault: SecretVault
  readonly #clock: Clock
  readonly #skewMs: number
  readonly #events: AuthEventSink
  readonly #logger: Logger
  readonly #redactor: SecretRedactor

  #cached: TokenSet | undefined
  #inFlight: Promise<TokenSet> | undefined
  #state: TokenManagerState = 'ready'

  constructor(options: TokenManagerOptions) {
    if (options.refreshSkewMs < 0) {
      throw new Error('refreshSkewMs must not be negative')
    }
    this.#client = options.client
    this.#vault = options.vault
    this.#clock = options.clock
    this.#skewMs = options.refreshSkewMs
    this.#events = options.events ?? nullAuthEventSink
    this.#logger = options.logger ?? silentLogger
    this.#redactor = options.redactor ?? new SecretRedactor()
  }

  get state(): TokenManagerState {
    return this.#state
  }

  /** Expiry of the cached access token, or undefined when nothing is cached. */
  get accessTokenExpiresAt(): string | undefined {
    return this.#cached?.expiresAt
  }

  /**
   * Persists a fresh grant from the login CLI: refresh token to the vault,
   * access token to memory. Clears a previous `revoked` latch.
   */
  async storeGrant(tokenSet: TokenSet): Promise<void> {
    if (tokenSet.refreshToken === undefined) {
      throw new Error('grant has no refresh token to store')
    }
    this.#redactor.register(tokenSet.refreshToken)
    this.#redactor.register(tokenSet.accessToken)
    await this.#vault.set(REFRESH_TOKEN_SECRET, tokenSet.refreshToken)
    this.#cached = tokenSet
    this.#state = 'ready'
    this.#events.emit({
      type: 'auth_login_completed',
      at: this.#clock.nowUtcIso(),
      grantedScopes: tokenSet.grantedScopes,
      accessTokenExpiresAt: tokenSet.expiresAt,
    })
  }

  /** Returns a token valid for at least `refreshSkewMs`, refreshing if needed. */
  async getAccessToken(): Promise<string> {
    this.#assertNotRevoked()
    const cached = this.#cached
    if (cached !== undefined && !this.#isExpiring(cached)) {
      return cached.accessToken
    }
    const refreshed = await this.#refresh()
    return refreshed.accessToken
  }

  /** Refreshes even when the cached token is still valid (fault-matrix drills). */
  async forceRefresh(): Promise<TokenSet> {
    this.#assertNotRevoked()
    this.#cached = undefined
    return this.#refresh()
  }

  /**
   * Revokes the grant at Google and drops the stored refresh token (spec §12.4:
   * consent withdrawal revokes the token immediately). Emits `auth_revoked` so
   * T13 can start its deletion window from the same signal.
   */
  async revokeGrant(): Promise<void> {
    const refreshToken = await this.#vault.get(REFRESH_TOKEN_SECRET)
    let revokeError: unknown
    if (refreshToken !== undefined) {
      this.#redactor.register(refreshToken)
      try {
        await this.#client.revoke(refreshToken)
      } catch (error) {
        revokeError = error
      }
    }
    // The local copy goes even when Google could not be reached: a withdrawn
    // consent must not leave a usable token on the host. The caller is told to
    // finish the revocation by hand.
    await this.#vault.delete(REFRESH_TOKEN_SECRET)
    this.#cached = undefined
    this.#latchRevoked('operator_revoked')
    if (revokeError !== undefined) {
      throw new Error(
        'the stored refresh token was deleted, but revoking it at Google failed; revoke the app manually at https://myaccount.google.com/permissions',
        { cause: revokeError },
      )
    }
  }

  #isExpiring(tokenSet: TokenSet): boolean {
    const nowMs = Date.parse(this.#clock.nowUtcIso())
    return tokenSet.expiresAtEpochMs - this.#skewMs <= nowMs
  }

  #assertNotRevoked(): void {
    if (this.#state === 'revoked') {
      throw new AuthRevokedError('invalid_grant')
    }
  }

  /** Single-flight: concurrent callers share one refresh request. */
  async #refresh(): Promise<TokenSet> {
    const inFlight = this.#inFlight
    if (inFlight !== undefined) {
      return inFlight
    }
    const attempt = this.#refreshOnce().finally(() => {
      this.#inFlight = undefined
    })
    this.#inFlight = attempt
    return attempt
  }

  async #refreshOnce(): Promise<TokenSet> {
    const stored = await this.#vault.get(REFRESH_TOKEN_SECRET)
    if (stored === undefined) {
      this.#latchRevoked('missing_refresh_token')
      throw new AuthRevokedError('missing_refresh_token')
    }
    this.#redactor.register(stored)

    try {
      const { tokenSet, rotated } = await this.#client.refresh(stored)
      this.#redactor.register(tokenSet.accessToken)
      if (rotated && tokenSet.refreshToken !== undefined) {
        this.#redactor.register(tokenSet.refreshToken)
        // Store before publishing the new access token: if the process dies
        // here the vault already holds the token the server will accept.
        await this.#vault.set(REFRESH_TOKEN_SECRET, tokenSet.refreshToken)
        this.#events.emit({ type: 'auth_refresh_token_rotated', at: this.#clock.nowUtcIso() })
        this.#logger.info('refresh token rotated')
      }
      this.#cached = tokenSet
      this.#events.emit({
        type: 'auth_token_refreshed',
        at: this.#clock.nowUtcIso(),
        accessTokenExpiresAt: tokenSet.expiresAt,
      })
      return tokenSet
    } catch (error) {
      const failure = error instanceof OAuthRequestError ? error.failure : classifyOAuthError(error)
      this.#emitFailure(failure)
      if (isRevocation(failure)) {
        this.#latchRevoked('invalid_grant', failure.description)
        throw new AuthRevokedError(
          'invalid_grant',
          this.#redactor.redact(failure.description ?? ''),
        )
      }
      throw error
    }
  }

  #emitFailure(failure: OAuthFailure): void {
    const detail =
      failure.description === undefined ? undefined : this.#redactor.redact(failure.description)
    this.#events.emit({
      type: 'auth_refresh_failed',
      at: this.#clock.nowUtcIso(),
      kind: failure.kind,
      retryable: failure.retryable,
      ...(detail === undefined ? {} : { detail }),
    })
    this.#logger.warn('access token refresh failed', {
      kind: failure.kind,
      retryable: failure.retryable,
      faultAction: failure.faultAction,
    })
  }

  #latchRevoked(reason: AuthRevokedReason, detail?: string): void {
    const alreadyRevoked = this.#state === 'revoked'
    this.#state = 'revoked'
    this.#cached = undefined
    if (alreadyRevoked) {
      return
    }
    const redacted = detail === undefined ? undefined : this.#redactor.redact(detail)
    this.#events.emit({
      type: 'auth_revoked',
      at: this.#clock.nowUtcIso(),
      reason,
      ...(redacted === undefined ? {} : { detail: redacted }),
    })
    this.#logger.error('youtube grant revoked', { reason })
  }
}
