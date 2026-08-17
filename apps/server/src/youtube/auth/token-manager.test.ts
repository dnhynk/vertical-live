import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemorySecretVault } from '../../secrets/memory.js'
import { SecretRedactor, createRedactingLogger, type LogFields } from '../../secrets/redaction.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { FakeOAuthServer } from '../../testing/fake-oauth-server.js'
import { RecordingAuthEventSink } from './events.js'
import { OAuthRequestError } from './errors.js'
import { OAuthClient } from './oauth-client.js'
import { AuthRevokedError, REFRESH_TOKEN_SECRET, TokenManager } from './token-manager.js'

/**
 * Acceptance criterion 1 (`docs/tasks/TASK_SPECS.md` §T3), refresh half:
 * 갱신·회전·철회 against the fake OAuth server, plus the "no secret reaches a
 * log or an event" requirement.
 */

const CLIENT_ID = 'synthetic-client-id.apps.googleusercontent.com'
const CLIENT_SECRET = 'synthetic-client-secret-000000'
const SKEW_MS = 120_000

let server: FakeOAuthServer

beforeEach(async () => {
  server = await FakeOAuthServer.start()
})

afterEach(async () => {
  await server.stop()
})

interface Harness {
  readonly manager: TokenManager
  readonly vault: InMemorySecretVault
  readonly clock: FakeClock
  readonly events: RecordingAuthEventSink
  readonly redactor: SecretRedactor
  readonly logLines: string[]
}

function createHarness(options: { storedRefreshToken?: string } = {}): Harness {
  // Base the fake clock on the real epoch: `google-auth-library` computes
  // `expiry_date` from the host clock, so both sides must share an origin for
  // `advance()` to mean "the access token aged".
  const clock = new FakeClock({ epochMs: Date.now() })
  const vault = new InMemorySecretVault(
    options.storedRefreshToken === undefined
      ? {}
      : { [REFRESH_TOKEN_SECRET]: options.storedRefreshToken },
  )
  const events = new RecordingAuthEventSink()
  const redactor = new SecretRedactor()
  const logLines: string[] = []
  const record = (message: string, fields?: LogFields): void => {
    logLines.push(`${message} ${JSON.stringify(fields ?? {})}`)
  }
  const logger = createRedactingLogger(
    { debug: record, info: record, warn: record, error: record },
    redactor,
  )

  const client = new OAuthClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    endpoints: server.endpoints,
    clock,
  })
  const manager = new TokenManager({
    client,
    vault,
    clock,
    refreshSkewMs: SKEW_MS,
    events,
    logger,
    redactor,
  })
  return { manager, vault, clock, events, redactor, logLines }
}

describe('TokenManager refresh', () => {
  it('refreshes with the stored refresh token and caches the access token', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })

    const first = await h.manager.getAccessToken()
    expect(first).toBe('synthetic-access-token-1')
    expect(server.requests).toHaveLength(1)
    expect(server.lastRequest?.grantType).toBe('refresh_token')

    // Still fresh: no second call to the token endpoint.
    expect(await h.manager.getAccessToken()).toBe(first)
    expect(server.requests).toHaveLength(1)
    expect(h.events.ofType('auth_token_refreshed')).toHaveLength(1)
  })

  it('refreshes again once the token is inside the skew window', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    await h.manager.getAccessToken()

    // 3600s lifetime, 120s skew: 60s before expiry the cached token is replaced.
    await h.clock.advance(3_540_000)
    expect(await h.manager.getAccessToken()).toBe('synthetic-access-token-2')
    expect(server.requests).toHaveLength(2)
  })

  it('shares one request between concurrent callers', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })

    const tokens = await Promise.all([
      h.manager.getAccessToken(),
      h.manager.getAccessToken(),
      h.manager.getAccessToken(),
    ])
    expect(new Set(tokens).size).toBe(1)
    expect(server.requests).toHaveLength(1)
  })

  it('persists a rotated refresh token before handing out the access token', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    server.scenario = 'rotate'

    await h.manager.getAccessToken()

    expect(await h.vault.get(REFRESH_TOKEN_SECRET)).toBe(server.rotatedRefreshToken)
    expect(h.events.ofType('auth_refresh_token_rotated')).toHaveLength(1)

    // The next refresh uses the rotated token, not the original one.
    await h.clock.advance(3_600_000)
    await h.manager.getAccessToken()
    expect(server.lastRequest?.params['refresh_token']).toBe(server.rotatedRefreshToken)
  })

  it('keeps the stored token when the endpoint does not rotate it', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    await h.manager.getAccessToken()

    expect(await h.vault.get(REFRESH_TOKEN_SECRET)).toBe(server.initialRefreshToken)
    expect(h.events.ofType('auth_refresh_token_rotated')).toHaveLength(0)
  })
})

describe('TokenManager revocation', () => {
  it('turns invalid_grant into a single AuthRevoked event and stops retrying', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    server.scenario = 'invalid_grant'

    await expect(h.manager.getAccessToken()).rejects.toBeInstanceOf(AuthRevokedError)
    expect(h.manager.state).toBe('revoked')

    const revoked = h.events.ofType('auth_revoked')
    expect(revoked).toHaveLength(1)
    expect(revoked[0]?.reason).toBe('invalid_grant')
    expect(h.events.ofType('auth_refresh_failed')[0]?.kind).toBe('revoked')

    // Latched: further calls fail without touching the token endpoint again.
    const requestsAfterFirstFailure = server.requests.length
    await expect(h.manager.getAccessToken()).rejects.toBeInstanceOf(AuthRevokedError)
    expect(server.requests).toHaveLength(requestsAfterFirstFailure)
    expect(h.events.ofType('auth_revoked')).toHaveLength(1)
  })

  it('reports a missing refresh token as revoked instead of looping', async () => {
    const h = createHarness()

    await expect(h.manager.getAccessToken()).rejects.toBeInstanceOf(AuthRevokedError)
    expect(h.events.ofType('auth_revoked')[0]?.reason).toBe('missing_refresh_token')
    expect(server.requests).toHaveLength(0)
  })

  it('revokes the grant at the endpoint and clears the vault', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    await h.manager.getAccessToken()

    await h.manager.revokeGrant()

    expect(server.revoked).toEqual([server.initialRefreshToken])
    expect(await h.vault.get(REFRESH_TOKEN_SECRET)).toBeUndefined()
    expect(h.manager.state).toBe('revoked')
    expect(h.events.ofType('auth_revoked')[0]?.reason).toBe('operator_revoked')
  })

  it('storeGrant clears a previous revocation and stores the refresh token', async () => {
    const h = createHarness()
    await expect(h.manager.getAccessToken()).rejects.toBeInstanceOf(AuthRevokedError)

    await h.manager.storeGrant({
      accessToken: 'synthetic-access-token-from-login',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      expiresAtEpochMs: Date.now() + 3_600_000,
      refreshToken: server.initialRefreshToken,
      grantedScopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
      tokenType: 'Bearer',
    })

    expect(h.manager.state).toBe('ready')
    expect(await h.vault.get(REFRESH_TOKEN_SECRET)).toBe(server.initialRefreshToken)
    expect(await h.manager.getAccessToken()).toBe('synthetic-access-token-from-login')
    expect(h.events.ofType('auth_login_completed')).toHaveLength(1)
  })
})

describe('TokenManager transient failures', () => {
  it('classifies a 429 as retryable and does not revoke', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    server.scenario = 'rate_limited'

    const error = await h.manager.getAccessToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OAuthRequestError)
    expect((error as OAuthRequestError).failure).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      faultAction: 'retry',
    })
    expect(h.manager.state).toBe('ready')
    expect(h.events.ofType('auth_revoked')).toHaveLength(0)

    // Recovers on the next attempt once the endpoint is healthy again.
    server.scenario = 'ok'
    expect(await h.manager.getAccessToken()).toBe('synthetic-access-token-1')
  })

  it('classifies a 500 as retryable', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    server.scenario = 'server_error'

    const error = await h.manager.getAccessToken().catch((e: unknown) => e)
    expect((error as OAuthRequestError).failure).toMatchObject({
      kind: 'server',
      retryable: true,
      faultAction: 'retry',
    })
  })

  it('classifies bad client credentials as safe_stopped', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    server.scenario = 'invalid_client'

    const error = await h.manager.getAccessToken().catch((e: unknown) => e)
    expect((error as OAuthRequestError).failure).toMatchObject({
      kind: 'invalid_client',
      retryable: false,
      faultAction: 'safe_stopped',
    })
  })
})

describe('secret exposure', () => {
  it('never writes a token value into logs, events or error messages', async () => {
    const h = createHarness({ storedRefreshToken: server.initialRefreshToken })
    server.scenario = 'rotate'
    const accessToken = await h.manager.getAccessToken()

    server.scenario = 'invalid_grant'
    await h.clock.advance(3_600_000)
    const revokedError = await h.manager.getAccessToken().catch((e: unknown) => e)

    const haystack = [
      h.logLines.join('\n'),
      JSON.stringify(h.events.events),
      (revokedError as Error).message,
      (revokedError as Error).stack ?? '',
    ].join('\n')

    for (const secret of [
      accessToken,
      server.initialRefreshToken,
      server.rotatedRefreshToken,
      CLIENT_SECRET,
    ]) {
      expect(haystack).not.toContain(secret)
    }
    // The events still carry what an operator needs.
    expect(haystack).toContain('auth_revoked')
    expect(haystack).toContain('invalid_grant')
  })
})
