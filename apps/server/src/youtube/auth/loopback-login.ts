import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Clock } from '../../clock.js'
import { silentLogger, type Logger } from '../../secrets/redaction.js'
import { classifyOAuthErrorBody, OAuthRequestError } from './errors.js'
import type { OAuthClient, TokenSet } from './oauth-client.js'

/**
 * Installed-app login over a loopback redirect (spec §10.2, §9.1: OAuth 승인은
 * 사람이 한 번 수행한다). The listener binds to the loopback address only and
 * exits as soon as the browser comes back, so nothing keeps listening after the
 * grant.
 *
 * Source (checked 2026-08-17):
 * https://developers.google.com/identity/protocols/oauth2/native-app —
 * "start an HTTP listener on a random available port", redirect URI form
 * `http://127.0.0.1:port`; `state` guards CSRF; `access_denied` is returned
 * when the user declines.
 */

export const DEFAULT_LOOPBACK_HOST = '127.0.0.1'

export interface LoopbackLoginOptions {
  readonly client: OAuthClient
  readonly scopes: readonly string[]
  readonly clock: Clock
  readonly timeoutMs: number
  /** Loopback address to bind. Anything else is rejected. */
  readonly host?: string
  /** 0 (default) asks the OS for a free port. */
  readonly port?: number
  readonly logger?: Logger
  /**
   * Receives the consent URL. The default prints it; the CLI may also open a
   * browser. Never auto-opens from tests.
   */
  readonly onAuthorizationUrl?: (url: string) => void | Promise<void>
}

export interface LoopbackLoginResult {
  readonly tokenSet: TokenSet
  readonly redirectUri: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export class LoginTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`login timed out after ${timeoutMs}ms without a redirect from the browser`)
    this.name = 'LoginTimeoutError'
  }
}

export class LoginStateMismatchError extends Error {
  constructor() {
    super('login redirect carried a state value that does not match this attempt')
    this.name = 'LoginStateMismatchError'
  }
}

export async function loginWithLoopback(
  options: LoopbackLoginOptions,
): Promise<LoopbackLoginResult> {
  const host = options.host ?? DEFAULT_LOOPBACK_HOST
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`login listener must bind a loopback address, got ${host}`)
  }
  const logger = options.logger ?? silentLogger
  const { codeVerifier, codeChallenge } = options.client.createPkcePair()
  const state = options.client.createState()

  const { code, redirectUri } = await awaitAuthorizationCode({
    ...options,
    host,
    logger,
    state,
    codeChallenge,
  })

  const tokenSet = await options.client.exchangeCode({ code, codeVerifier, redirectUri })
  logger.info('authorization code exchanged', {
    grantedScopes: tokenSet.grantedScopes.join(' '),
    accessTokenExpiresAt: tokenSet.expiresAt,
  })
  return { tokenSet, redirectUri }
}

interface AwaitCodeOptions extends LoopbackLoginOptions {
  readonly host: string
  readonly logger: Logger
  readonly state: string
  readonly codeChallenge: string
}

function awaitAuthorizationCode(
  options: AwaitCodeOptions,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const server = createServer()

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      options.clock.clearTimeout(timer)
      // Browsers keep the connection alive; drop them so close() completes.
      server.closeAllConnections()
      server.close(() => fn())
    }

    const timer = options.clock.setTimeout(() => {
      finish(() => reject(new LoginTimeoutError(options.timeoutMs)))
    }, options.timeoutMs)

    server.on('error', (error) => {
      finish(() => reject(error))
    })

    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const remote = req.socket.remoteAddress ?? ''
      if (!isLoopbackAddress(remote)) {
        respond(res, 403, 'Forbidden', 'This listener only accepts loopback requests.')
        return
      }
      const url = new URL(req.url ?? '/', `http://${options.host}`)
      if (url.pathname === '/favicon.ico') {
        respond(res, 404, 'Not found', '')
        return
      }

      const errorParam = url.searchParams.get('error')
      if (errorParam !== null) {
        respond(
          res,
          400,
          'Sign-in was not completed',
          'You can close this tab and run the login command again.',
        )
        const description = url.searchParams.get('error_description')
        const failure = classifyOAuthErrorBody(
          {
            error: errorParam,
            ...(description === null ? {} : { error_description: description }),
          },
          400,
        )
        finish(() => reject(new OAuthRequestError(`authorization refused: ${errorParam}`, failure)))
        return
      }

      const receivedState = url.searchParams.get('state')
      if (receivedState === null || !constantTimeEquals(receivedState, options.state)) {
        respond(res, 400, 'Sign-in was not completed', 'The request could not be verified.')
        options.logger.warn('login redirect rejected: state mismatch')
        finish(() => reject(new LoginStateMismatchError()))
        return
      }

      const code = url.searchParams.get('code')
      if (code === null || code === '') {
        respond(
          res,
          400,
          'Sign-in was not completed',
          'The redirect carried no authorization code.',
        )
        finish(() =>
          reject(
            new OAuthRequestError('authorization redirect carried no code', {
              kind: 'invalid_request',
              retryable: false,
              faultAction: 'degraded',
            }),
          ),
        )
        return
      }

      respond(
        res,
        200,
        'Sign-in complete',
        'The credential was stored in the Windows Credential Manager. You can close this tab.',
      )
      finish(() => resolve({ code, redirectUri: redirectUriRef.value }))
    })

    const redirectUriRef = { value: '' }
    server.listen(options.port ?? 0, options.host, () => {
      const address = server.address() as AddressInfo | null
      if (address === null) {
        finish(() => reject(new Error('login listener did not report an address')))
        return
      }
      redirectUriRef.value = `http://${options.host}:${address.port}`
      const authorizationUrl = options.client.buildAuthorizationUrl({
        scopes: options.scopes,
        state: options.state,
        codeChallenge: options.codeChallenge,
        redirectUri: redirectUriRef.value,
      })
      options.logger.info('waiting for the consent redirect', {
        redirectUri: redirectUriRef.value,
        timeoutMs: options.timeoutMs,
      })
      void Promise.resolve(
        options.onAuthorizationUrl === undefined
          ? printAuthorizationUrl(authorizationUrl)
          : options.onAuthorizationUrl(authorizationUrl),
      ).catch((error: unknown) => {
        finish(() => reject(error))
      })
    })
  })
}

function printAuthorizationUrl(url: string): void {
  process.stdout.write(`\nOpen this URL in a browser signed in as the channel owner:\n${url}\n\n`)
}

function respond(res: ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${body}</p></body>`
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.')
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) {
    return false
  }
  return timingSafeEqual(left, right)
}
