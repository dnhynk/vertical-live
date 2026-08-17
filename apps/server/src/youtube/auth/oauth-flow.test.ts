import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../testing/fake-clock.js'
import { FakeOAuthServer } from '../../testing/fake-oauth-server.js'
import { REQUIRED_SCOPES } from '../scopes.js'
import { OAuthRequestError } from './errors.js'
import { LoginStateMismatchError, LoginTimeoutError, loginWithLoopback } from './loopback-login.js'
import { OAuthClient } from './oauth-client.js'

/**
 * Acceptance criterion 1 (`docs/tasks/TASK_SPECS.md` §T3): login, refresh,
 * rotation and revocation against a fake OAuth server. This file covers the
 * login half (loopback redirect + PKCE + code exchange); `token-manager.test.ts`
 * covers refresh/rotation/revocation.
 */

const CLIENT_ID = 'synthetic-client-id.apps.googleusercontent.com'
const CLIENT_SECRET = 'synthetic-client-secret-000000'

let server: FakeOAuthServer

beforeEach(async () => {
  server = await FakeOAuthServer.start()
})

afterEach(async () => {
  await server.stop()
})

function createClient(clock = new FakeClock()): OAuthClient {
  return new OAuthClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    endpoints: server.endpoints,
    clock,
  })
}

/** Plays the browser: reads the consent URL and calls the loopback redirect. */
function browserRedirect(
  authorizationUrl: string,
  overrides: { code?: string | null; state?: string | null; error?: string } = {},
): Promise<Response> {
  const url = new URL(authorizationUrl)
  const redirectUri = url.searchParams.get('redirect_uri') ?? ''
  const state = overrides.state === undefined ? url.searchParams.get('state') : overrides.state
  const target = new URL(redirectUri)
  if (overrides.error !== undefined) {
    target.searchParams.set('error', overrides.error)
  } else if (overrides.code !== null) {
    target.searchParams.set('code', overrides.code ?? 'synthetic-authorization-code')
  }
  if (state !== null) {
    target.searchParams.set('state', state)
  }
  return fetch(target)
}

describe('loginWithLoopback', () => {
  it('completes the installed-app flow and returns a refresh token', async () => {
    const clock = new FakeClock()
    const client = createClient(clock)
    let consentUrl = ''

    const login = loginWithLoopback({
      client,
      scopes: REQUIRED_SCOPES,
      clock,
      timeoutMs: 60_000,
      onAuthorizationUrl: (url) => {
        consentUrl = url
        // The fake token endpoint verifies the PKCE challenge from this URL.
        server.expectedCodeChallenge = new URL(url).searchParams.get('code_challenge') ?? undefined
        server.expectedCode = 'synthetic-authorization-code'
      },
    })

    // Wait until the listener published the consent URL, then play the browser.
    await vi_waitFor(() => consentUrl !== '')
    const consent = new URL(consentUrl)
    expect(consent.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(consent.searchParams.get('access_type')).toBe('offline')
    expect(consent.searchParams.get('prompt')).toBe('consent')
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256')
    expect(consent.searchParams.get('scope')).toBe(REQUIRED_SCOPES.join(' '))

    const response = await browserRedirect(consentUrl)
    expect(response.status).toBe(200)
    const page = await response.text()
    expect(page).not.toContain('synthetic-authorization-code')

    const { tokenSet } = await login
    expect(tokenSet.refreshToken).toBe(server.initialRefreshToken)
    expect(tokenSet.accessToken).toContain('synthetic-access-token')
    expect(tokenSet.grantedScopes).toEqual([...REQUIRED_SCOPES])
    expect(Date.parse(tokenSet.expiresAt)).toBe(tokenSet.expiresAtEpochMs)

    const exchange = server.lastRequest
    expect(exchange?.grantType).toBe('authorization_code')
    expect(exchange?.params['code_verifier']).toBeTruthy()
  })

  it('rejects when the operator declines consent', async () => {
    const clock = new FakeClock()
    let consentUrl = ''
    const login = settle(
      loginWithLoopback({
        client: createClient(clock),
        scopes: REQUIRED_SCOPES,
        clock,
        timeoutMs: 60_000,
        onAuthorizationUrl: (url) => {
          consentUrl = url
        },
      }),
    )
    await vi_waitFor(() => consentUrl !== '')
    const response = await browserRedirect(consentUrl, { error: 'access_denied' })
    expect(response.status).toBe(400)

    const { error } = await login
    expect(error).toBeInstanceOf(OAuthRequestError)
    expect((error as OAuthRequestError).failure.kind).toBe('user_denied')
    expect((error as OAuthRequestError).failure.faultAction).toBe('safe_stopped')
    // The code was never exchanged.
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a redirect whose state does not match', async () => {
    const clock = new FakeClock()
    let consentUrl = ''
    const login = settle(
      loginWithLoopback({
        client: createClient(clock),
        scopes: REQUIRED_SCOPES,
        clock,
        timeoutMs: 60_000,
        onAuthorizationUrl: (url) => {
          consentUrl = url
        },
      }),
    )
    await vi_waitFor(() => consentUrl !== '')
    const response = await browserRedirect(consentUrl, { state: 'forged-state-value' })
    expect(response.status).toBe(400)

    expect((await login).error).toBeInstanceOf(LoginStateMismatchError)
    expect(server.requests).toHaveLength(0)
  })

  it('rejects a redirect without a code', async () => {
    const clock = new FakeClock()
    let consentUrl = ''
    const login = settle(
      loginWithLoopback({
        client: createClient(clock),
        scopes: REQUIRED_SCOPES,
        clock,
        timeoutMs: 60_000,
        onAuthorizationUrl: (url) => {
          consentUrl = url
        },
      }),
    )
    await vi_waitFor(() => consentUrl !== '')
    await browserRedirect(consentUrl, { code: null })
    expect((await login).error).toMatchObject({
      message: 'authorization redirect carried no code',
    })
  })

  it('times out instead of listening forever', async () => {
    const clock = new FakeClock()
    let consentUrl = ''
    const login = settle(
      loginWithLoopback({
        client: createClient(clock),
        scopes: REQUIRED_SCOPES,
        clock,
        timeoutMs: 300_000,
        onAuthorizationUrl: (url) => {
          consentUrl = url
        },
      }),
    )
    await vi_waitFor(() => consentUrl !== '')
    await clock.advance(300_000)
    expect((await login).error).toBeInstanceOf(LoginTimeoutError)

    // The listener is gone: nothing answers on the redirect port any more.
    const redirectUri = new URL(consentUrl).searchParams.get('redirect_uri') ?? ''
    await expect(fetch(redirectUri)).rejects.toBeTruthy()
  })

  it('surfaces a token-endpoint rejection of the code exchange', async () => {
    const clock = new FakeClock()
    let consentUrl = ''
    const login = settle(
      loginWithLoopback({
        client: createClient(clock),
        scopes: REQUIRED_SCOPES,
        clock,
        timeoutMs: 60_000,
        onAuthorizationUrl: (url) => {
          consentUrl = url
          server.expectedCode = 'a-different-code'
        },
      }),
    )
    await vi_waitFor(() => consentUrl !== '')
    await browserRedirect(consentUrl)

    const { error } = await login
    expect(error).toBeInstanceOf(OAuthRequestError)
    expect((error as OAuthRequestError).failure.kind).toBe('revoked')
    expect((error as OAuthRequestError).message).toContain('invalid_grant')
  })

  it('refuses to bind anything but a loopback address', async () => {
    const clock = new FakeClock()
    await expect(
      loginWithLoopback({
        client: createClient(clock),
        scopes: REQUIRED_SCOPES,
        clock,
        timeoutMs: 1000,
        host: '0.0.0.0',
      }),
    ).rejects.toThrow('must bind a loopback address')
  })
})

/**
 * Attaches handlers at creation time. A login promise that rejects while the
 * test is still driving the browser would otherwise be reported as an unhandled
 * rejection before the assertion attaches its handler.
 */
function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
}

/** Polls until `predicate` holds; the listener publishes its URL asynchronously. */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for the login listener to publish its URL')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
