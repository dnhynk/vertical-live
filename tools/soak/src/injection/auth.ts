import {
  AuthRevokedError,
  InMemorySecretVault,
  OAuthClient,
  REFRESH_TOKEN_SECRET,
  TokenManager,
  type AuthEvent,
  type AuthEventSink,
  type Clock,
} from '@vl/server'
import { FakeOAuthServer } from '@vl/server/testing'

/**
 * The OAuth grant under fault injection (spec §11 rows "OAuth access-token
 * 만료", "refresh-token 철회"; §10.2 "access-token 갱신, refresh-token rotation,
 * 철회·재동의 절차를 시험한다").
 *
 * Everything here is the production path: the real `TokenManager`, the real
 * `OAuthClient` (and therefore `google-auth-library`'s own request encoding),
 * over real HTTP to T3's loopback fake token endpoint. Only the endpoint's answer
 * is chosen by the drill. The refresh token lives in an in-memory vault and every
 * value the endpoint hands out is an obviously synthetic string (CLAUDE.md §3).
 */

export interface FaultyAuthOptions {
  readonly clock: Clock
  /** Where auth events go — in the soak, `Supervisor.onAuthEvent`. */
  readonly events: AuthEventSink
  readonly refreshSkewMs?: number
}

const SYNTHETIC_CLIENT_ID = 'soak-synthetic-client-id.apps.googleusercontent.com'
const SYNTHETIC_CLIENT_SECRET = 'soak-synthetic-client-secret'

export class FaultyAuth {
  readonly tokens: TokenManager
  readonly vault: InMemorySecretVault
  readonly #server: FakeOAuthServer

  /** Every event the manager emitted, so a drill can prove `auth_revoked` fired. */
  readonly events: readonly AuthEvent[]

  private constructor(
    server: FakeOAuthServer,
    tokens: TokenManager,
    vault: InMemorySecretVault,
    events: readonly AuthEvent[],
  ) {
    this.#server = server
    this.tokens = tokens
    this.vault = vault
    this.events = events
  }

  static async start(options: FaultyAuthOptions): Promise<FaultyAuth> {
    const server = await FakeOAuthServer.start()
    const vault = new InMemorySecretVault({
      [REFRESH_TOKEN_SECRET]: server.initialRefreshToken,
    })
    const recorded: AuthEvent[] = []
    const tokens = new TokenManager({
      client: new OAuthClient({
        clientId: SYNTHETIC_CLIENT_ID,
        clientSecret: SYNTHETIC_CLIENT_SECRET,
        endpoints: server.endpoints,
        clock: options.clock,
      }),
      vault,
      clock: options.clock,
      refreshSkewMs: options.refreshSkewMs ?? 120_000,
      events: {
        emit: (event) => {
          recorded.push(event)
          options.events.emit(event)
        },
      },
    })
    return new FaultyAuth(server, tokens, vault, recorded)
  }

  /** Revokes the grant at the endpoint: the next refresh answers `invalid_grant`. */
  revokeRefreshToken(): void {
    this.#server.scenario = 'invalid_grant'
  }

  /** The endpoint rotates the refresh token on the next refresh (§10.2). */
  rotateRefreshToken(): void {
    this.#server.scenario = 'rotate'
  }

  restore(): void {
    this.#server.scenario = 'ok'
  }

  get tokenRequests(): number {
    return this.#server.requests.length
  }

  /**
   * One use of the grant, as a caller would: ask for a token, and report whether
   * the grant is gone. `AuthRevokedError` is the latched state, not an exception
   * the caller is expected to retry.
   */
  async useGrant(): Promise<{ readonly token: string | null; readonly revoked: boolean }> {
    try {
      return { token: await this.tokens.getAccessToken(), revoked: false }
    } catch (error) {
      if (error instanceof AuthRevokedError) return { token: null, revoked: true }
      return { token: null, revoked: this.tokens.state === 'revoked' }
    }
  }

  /** Discards the cached access token and refreshes (T3's fault-matrix entry). */
  async forceRefresh(): Promise<{ readonly token: string | null; readonly revoked: boolean }> {
    try {
      const tokenSet = await this.tokens.forceRefresh()
      return { token: tokenSet.accessToken, revoked: false }
    } catch (error) {
      if (error instanceof AuthRevokedError) return { token: null, revoked: true }
      return { token: null, revoked: this.tokens.state === 'revoked' }
    }
  }

  async close(): Promise<void> {
    await this.#server.stop()
  }
}
