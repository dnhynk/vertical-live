import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthEndpoints } from '../youtube/auth/oauth-client.js'

/**
 * Fake Google OAuth 2.0 token endpoint for tests (`docs/tasks/TASK_SPECS.md`
 * §T3 acceptance 1: 가짜 OAuth 서버로 로그인·갱신·회전·철회 시나리오 테스트).
 *
 * It is a real loopback HTTP server, so the production code path — including
 * `google-auth-library`'s request encoding — is what the tests exercise. Every
 * value it hands out is an obvious synthetic string (CLAUDE.md §3: no real
 * credentials in fixtures).
 *
 * Response shapes follow
 * https://developers.google.com/identity/protocols/oauth2/native-app
 * (token response fields, RFC 6749 `error`/`error_description` bodies).
 */

export type TokenScenario =
  /** Normal success. */
  | 'ok'
  /** Success that also returns a *new* refresh token (rotation). */
  | 'rotate'
  /** Refresh token revoked/expired: HTTP 400 `invalid_grant`. */
  | 'invalid_grant'
  /** Bad client credentials: HTTP 401 `invalid_client`. */
  | 'invalid_client'
  /** HTTP 429 with `rate_limit_exceeded`. */
  | 'rate_limited'
  /** HTTP 500 `server_error`. */
  | 'server_error'

export interface FakeTokenRequest {
  readonly grantType: string
  readonly params: Readonly<Record<string, string>>
}

export interface FakeOAuthServerOptions {
  /** Access-token lifetime handed out; 3600 by default. */
  readonly expiresInSeconds?: number
  readonly scope?: string
}

const SYNTHETIC_ACCESS_TOKEN = 'synthetic-access-token'
const SYNTHETIC_REFRESH_TOKEN = 'synthetic-refresh-token-initial-0000'
const SYNTHETIC_ROTATED_REFRESH_TOKEN = 'synthetic-refresh-token-rotated-111'

export class FakeOAuthServer {
  readonly requests: FakeTokenRequest[] = []
  readonly revoked: string[] = []
  /** Next scenario the token endpoint answers with. */
  scenario: TokenScenario = 'ok'
  /** When set, the token endpoint verifies the PKCE S256 challenge. */
  expectedCodeChallenge: string | undefined
  /** When set, the token endpoint only accepts this authorization code. */
  expectedCode: string | undefined

  readonly #server: Server
  readonly #expiresInSeconds: number
  readonly #scope: string
  #accessTokenSerial = 0
  #baseUrl = ''

  private constructor(server: Server, options: FakeOAuthServerOptions) {
    this.#server = server
    this.#expiresInSeconds = options.expiresInSeconds ?? 3600
    this.#scope = options.scope ?? 'https://www.googleapis.com/auth/youtube.force-ssl'
    server.on('request', (req, res) => {
      void this.#handle(req, res)
    })
  }

  static async start(options: FakeOAuthServerOptions = {}): Promise<FakeOAuthServer> {
    const server = createServer()
    const fake = new FakeOAuthServer(server, options)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    fake.#baseUrl = `http://127.0.0.1:${address.port}`
    return fake
  }

  get endpoints(): OAuthEndpoints {
    return {
      authorizationUrl: `${this.#baseUrl}/o/oauth2/v2/auth`,
      tokenUrl: `${this.#baseUrl}/token`,
      revokeUrl: `${this.#baseUrl}/revoke`,
    }
  }

  /** The refresh token the first (authorization code) grant hands out. */
  get initialRefreshToken(): string {
    return SYNTHETIC_REFRESH_TOKEN
  }

  /** The refresh token the `rotate` scenario hands out. */
  get rotatedRefreshToken(): string {
    return SYNTHETIC_ROTATED_REFRESH_TOKEN
  }

  get lastRequest(): FakeTokenRequest | undefined {
    return this.requests.at(-1)
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.#baseUrl)
    const body = await readBody(req)
    const params = Object.fromEntries(new URLSearchParams(body))

    if (url.pathname === '/revoke') {
      const token = params['token'] ?? url.searchParams.get('token') ?? ''
      this.revoked.push(token)
      json(res, 200, {})
      return
    }
    if (url.pathname !== '/token') {
      json(res, 404, { error: 'not_found' })
      return
    }

    const grantType = params['grant_type'] ?? ''
    this.requests.push({ grantType, params })

    switch (this.scenario) {
      case 'invalid_grant':
        json(res, 400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        })
        return
      case 'invalid_client':
        json(res, 401, { error: 'invalid_client', error_description: 'Unauthorized' })
        return
      case 'rate_limited':
        json(res, 429, { error: 'rate_limit_exceeded', error_description: 'Slow down' })
        return
      case 'server_error':
        json(res, 500, { error: 'server_error', error_description: 'Backend error' })
        return
      default:
        break
    }

    if (grantType === 'authorization_code') {
      const rejection = this.#checkAuthorizationCode(params)
      if (rejection !== undefined) {
        json(res, 400, rejection)
        return
      }
      json(res, 200, this.#tokenResponse(SYNTHETIC_REFRESH_TOKEN))
      return
    }

    if (grantType === 'refresh_token') {
      if ((params['refresh_token'] ?? '') === '') {
        json(res, 400, { error: 'invalid_request', error_description: 'Missing refresh_token' })
        return
      }
      json(
        res,
        200,
        this.#tokenResponse(
          this.scenario === 'rotate' ? SYNTHETIC_ROTATED_REFRESH_TOKEN : undefined,
        ),
      )
      return
    }

    json(res, 400, { error: 'unsupported_grant_type', error_description: grantType })
  }

  #checkAuthorizationCode(
    params: Record<string, string>,
  ): { error: string; error_description: string } | undefined {
    if (this.expectedCode !== undefined && params['code'] !== this.expectedCode) {
      return { error: 'invalid_grant', error_description: 'Unknown authorization code' }
    }
    if (this.expectedCodeChallenge !== undefined) {
      const verifier = params['code_verifier'] ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (challenge !== this.expectedCodeChallenge) {
        return { error: 'invalid_grant', error_description: 'code_verifier does not match' }
      }
    }
    return undefined
  }

  #tokenResponse(refreshToken: string | undefined): Record<string, unknown> {
    this.#accessTokenSerial += 1
    return {
      access_token: `${SYNTHETIC_ACCESS_TOKEN}-${this.#accessTokenSerial}`,
      expires_in: this.#expiresInSeconds,
      scope: this.#scope,
      token_type: 'Bearer',
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    }
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
