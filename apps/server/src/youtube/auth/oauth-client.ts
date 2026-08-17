import { createHash, randomBytes } from 'node:crypto'
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library'
import type { Clock } from '../../clock.js'
import { classifyOAuthError, OAuthRequestError } from './errors.js'
import { parseScopeString } from '../scopes.js'

/**
 * OAuth 2.0 installed-app client (spec §10.2). Google's own
 * `google-auth-library` performs the protocol; this wrapper pins the parts the
 * product depends on.
 *
 * Why this package and not the `googleapis` barrel (review round 1, M1):
 * `googleapis` re-exports exactly this library (`export * as Auth from
 * 'google-auth-library'`) and pins it at the **exact** version `10.5.0`, so a
 * direct dependency on `google-auth-library@10.5.0` cannot drift from what
 * `googleapis@174.0.1` itself loads — it is one copy either way. Reaching it
 * through the barrel costs 5,194 ms of module loading against 4 ms for the
 * library alone (measured on the T3 host, Node 24.11.1), which every server
 * start and every auth test would pay. Both packages are declared with exact
 * versions in `apps/server/package.json`; `googleapis` is the Data API client
 * T9/T10 call (`TASK_SPECS.md` §T3).
 *
 * This wrapper pins:
 *
 * - loopback redirect + PKCE, per
 *   https://developers.google.com/identity/protocols/oauth2/native-app
 *   ("Query your platform for the relevant loopback IP address and start an
 *   HTTP listener on a random available port", `http://127.0.0.1:port`)
 * - `access_type=offline` + `prompt=consent` so a refresh token is issued
 * - refresh-token rotation: the token endpoint may return a *new* refresh
 *   token, which must replace the stored one
 * - normalized `TokenSet` so nothing above this layer touches library types
 *
 * Endpoints are injectable: the fake OAuth server in the tests is a real HTTP
 * server, so the tested code path is the production one.
 */

export interface OAuthEndpoints {
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string
}

/** Checked 2026-08-17 against the installed-app guide (see module comment). */
export const GOOGLE_OAUTH_ENDPOINTS: OAuthEndpoints = Object.freeze({
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
})

export interface TokenSet {
  readonly accessToken: string
  /** Absolute UTC ISO 8601 expiry (spec §10.2 persists absolute instants). */
  readonly expiresAt: string
  readonly expiresAtEpochMs: number
  /** Present on the first grant and whenever the endpoint rotates it. */
  readonly refreshToken?: string
  readonly grantedScopes: readonly string[]
  readonly tokenType: string
}

export interface RefreshResult {
  readonly tokenSet: TokenSet
  /** True when the endpoint returned a refresh token different from the one sent. */
  readonly rotated: boolean
}

export interface PkcePair {
  readonly codeVerifier: string
  readonly codeChallenge: string
}

export interface OAuthClientOptions {
  readonly clientId: string
  /** Installed-app clients still receive one; PKCE covers the flow when absent. */
  readonly clientSecret?: string
  readonly endpoints?: OAuthEndpoints
  readonly clock: Clock
  /** Injected in tests; defaults to `node:crypto`. */
  readonly randomBytesFn?: (size: number) => Buffer
}

export interface AuthorizationUrlOptions {
  readonly scopes: readonly string[]
  readonly state: string
  readonly codeChallenge: string
  readonly redirectUri: string
  /** Adds `login_hint`; never logged. */
  readonly loginHint?: string
}

export class OAuthClient {
  readonly endpoints: OAuthEndpoints
  readonly #clientId: string
  readonly #clientSecret: string | undefined
  readonly #clock: Clock
  readonly #randomBytes: (size: number) => Buffer

  constructor(options: OAuthClientOptions) {
    if (options.clientId === '') {
      throw new Error('OAuth client id is empty')
    }
    this.#clientId = options.clientId
    this.#clientSecret = options.clientSecret
    this.endpoints = options.endpoints ?? GOOGLE_OAUTH_ENDPOINTS
    this.#clock = options.clock
    this.#randomBytes = options.randomBytesFn ?? randomBytes
  }

  /** RFC 7636 S256 pair. 32 random bytes → 43-character base64url verifier. */
  createPkcePair(): PkcePair {
    const codeVerifier = base64Url(this.#randomBytes(32))
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest())
    return { codeVerifier, codeChallenge }
  }

  /** CSRF state for the loopback redirect. */
  createState(): string {
    return base64Url(this.#randomBytes(16))
  }

  buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
    return this.#client(options.redirectUri).generateAuthUrl({
      access_type: 'offline',
      // Forces a refresh token even when the operator already granted consent.
      prompt: 'consent',
      scope: [...options.scopes],
      state: options.state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: options.codeChallenge,
      ...(options.loginHint === undefined ? {} : { login_hint: options.loginHint }),
    })
  }

  async exchangeCode(options: {
    code: string
    codeVerifier: string
    redirectUri: string
  }): Promise<TokenSet> {
    const client = this.#client(options.redirectUri)
    try {
      const { tokens } = await client.getToken({
        code: options.code,
        codeVerifier: options.codeVerifier,
        redirect_uri: options.redirectUri,
      })
      const tokenSet = this.#toTokenSet(tokens)
      if (tokenSet.refreshToken === undefined) {
        throw new Error(
          'token endpoint returned no refresh token; the login was requested with access_type=offline and prompt=consent',
        )
      }
      return tokenSet
    } catch (error) {
      throw this.#wrap('authorization code exchange failed', error)
    }
  }

  async refresh(refreshToken: string): Promise<RefreshResult> {
    const client = this.#client()
    client.setCredentials({ refresh_token: refreshToken })
    // `refreshAccessToken()` copies the *previous* refresh token back over the
    // response (google-auth-library `refreshAccessTokenAsync`), which would hide
    // a rotation. The `tokens` event carries the untouched response body, so
    // rotation is detected there.
    // Copied, not referenced: the library mutates the very object it emitted.
    let raw: Credentials | undefined
    client.on('tokens', (tokens: Credentials) => {
      raw = { ...tokens }
    })
    try {
      const { credentials } = await client.refreshAccessToken()
      const tokenSet = this.#toTokenSet(raw ?? credentials)
      return {
        tokenSet,
        rotated: tokenSet.refreshToken !== undefined && tokenSet.refreshToken !== refreshToken,
      }
    } catch (error) {
      throw this.#wrap('access token refresh failed', error)
    }
  }

  /**
   * Revokes a grant (spec §12.4: withdrawal revokes the token immediately).
   * Passing the refresh token revokes the whole grant.
   */
  async revoke(token: string): Promise<void> {
    try {
      await this.#client().revokeToken(token)
    } catch (error) {
      throw this.#wrap('token revocation failed', error)
    }
  }

  #client(redirectUri?: string): OAuth2Client {
    return new OAuth2Client({
      clientId: this.#clientId,
      ...(this.#clientSecret === undefined ? {} : { clientSecret: this.#clientSecret }),
      ...(redirectUri === undefined ? {} : { redirectUri }),
      endpoints: {
        oauth2AuthBaseUrl: this.endpoints.authorizationUrl,
        oauth2TokenUrl: this.endpoints.tokenUrl,
        oauth2RevokeUrl: this.endpoints.revokeUrl,
      },
    })
  }

  #toTokenSet(credentials: {
    access_token?: string | null
    refresh_token?: string | null
    expiry_date?: number | null
    scope?: string
    token_type?: string | null
  }): TokenSet {
    const accessToken = credentials.access_token
    if (accessToken === undefined || accessToken === null || accessToken === '') {
      throw new Error('token endpoint returned no access token')
    }
    const expiresAtEpochMs =
      typeof credentials.expiry_date === 'number'
        ? credentials.expiry_date
        : Date.parse(this.#clock.nowUtcIso())

    return {
      accessToken,
      expiresAt: new Date(expiresAtEpochMs).toISOString(),
      expiresAtEpochMs,
      ...(credentials.refresh_token === undefined || credentials.refresh_token === null
        ? {}
        : { refreshToken: credentials.refresh_token }),
      grantedScopes: parseScopeString(credentials.scope),
      tokenType: credentials.token_type ?? 'Bearer',
    }
  }

  /** Classifies and re-throws without ever attaching the response body verbatim. */
  #wrap(context: string, error: unknown): OAuthRequestError {
    const failure = classifyOAuthError(error)
    const detail = failure.oauthError ?? failure.kind
    return new OAuthRequestError(`${context}: ${detail}`, failure)
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}
