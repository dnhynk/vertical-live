import type { Clock } from '../../clock.js'
import { systemClock } from '../../clock.js'
import { resolveSecretVault } from '../../secrets/resolve.js'
import { SecretRedactor, createRedactingLogger, type Logger } from '../../secrets/redaction.js'
import type { SecretVault } from '../../secrets/vault.js'
import { checkScopeCoverage } from '../scopes.js'
import { loadOAuthClientCredentials, loadYouTubeAuthConfig } from './config.js'
import { classifyOAuthError } from './errors.js'
import { RecordingAuthEventSink } from './events.js'
import { loginWithLoopback } from './loopback-login.js'
import { OAuthClient, type OAuthEndpoints } from './oauth-client.js'
import { TokenManager } from './token-manager.js'

/**
 * `npm run auth:login -w @vl/server` — the one-time human step spec §9.1 keeps
 * outside the automation boundary ("OAuth 승인, stream key와 비밀정보 제공").
 *
 * It runs the installed-app flow, stores the refresh token in the vault and
 * prints a summary that contains no secret. `--revoke` performs the withdrawal
 * path (spec §12.4): revoke at Google, delete the stored token, emit
 * `auth_revoked` so T13 can start its deletion window.
 */

export interface LoginCliIo {
  write(line: string): void
}

export interface LoginCliDeps {
  readonly io: LoginCliIo
  readonly env?: NodeJS.ProcessEnv
  readonly clock?: Clock
  /** Injected in tests; production resolves the OS vault. */
  readonly vault?: SecretVault
  readonly logger?: Logger
  /** Injected in tests so no test can reach Google's real endpoints. */
  readonly endpoints?: OAuthEndpoints
}

export interface LoginCliOptions {
  readonly revoke: boolean
  readonly help: boolean
}

const USAGE = `usage:
  auth:login            run the OAuth installed-app login and store the refresh token
  auth:login --revoke   revoke the grant at Google and delete the stored refresh token`

export function parseLoginArgs(argv: readonly string[]): LoginCliOptions {
  return {
    revoke: argv.includes('--revoke'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
}

export async function runLoginCli(argv: readonly string[], deps: LoginCliDeps): Promise<number> {
  const options = parseLoginArgs(argv)
  if (options.help) {
    deps.io.write(USAGE)
    return 0
  }

  const env = deps.env ?? process.env
  const clock = deps.clock ?? systemClock
  const redactor = new SecretRedactor()
  const logger = createRedactingLogger(
    deps.logger ?? {
      debug: () => {},
      info: (message, fields) => deps.io.write(format(message, fields)),
      warn: (message, fields) => deps.io.write(format(`warning: ${message}`, fields)),
      error: (message, fields) => deps.io.write(format(`error: ${message}`, fields)),
    },
    redactor,
  )

  try {
    const config = loadYouTubeAuthConfig({ env })
    const credentials = loadOAuthClientCredentials(env)
    redactor.register(credentials.clientSecret)

    const vault =
      deps.vault ?? (await resolveSecretVault({ service: config.credentialService, logger }))
    const client = new OAuthClient({
      clientId: credentials.clientId,
      ...(credentials.clientSecret === undefined ? {} : { clientSecret: credentials.clientSecret }),
      ...(deps.endpoints === undefined ? {} : { endpoints: deps.endpoints }),
      clock,
    })
    const events = new RecordingAuthEventSink()
    const manager = new TokenManager({
      client,
      vault,
      clock,
      refreshSkewMs: config.accessTokenRefreshSkewMs,
      events,
      logger,
      redactor,
    })

    if (options.revoke) {
      await manager.revokeGrant()
      deps.io.write('grant revoked and refresh token deleted from the vault')
      deps.io.write(`events: ${events.events.map((event) => event.type).join(', ')}`)
      return 0
    }

    const { tokenSet } = await loginWithLoopback({
      client,
      scopes: config.scopes,
      clock,
      timeoutMs: config.loginTimeoutMs,
      host: config.loopbackHost,
      logger,
    })
    await manager.storeGrant(tokenSet)

    const coverage = checkScopeCoverage(tokenSet.grantedScopes)
    if (!coverage.sufficient) {
      deps.io.write(
        `warning: the grant does not cover ${coverage.uncoveredMethods.join(', ')} — re-run the login and accept every requested permission`,
      )
    }
    deps.io.write('login complete')
    deps.io.write(`  vault:          ${vault.source} (service ${config.credentialService})`)
    deps.io.write(`  granted scopes: ${tokenSet.grantedScopes.join(' ')}`)
    deps.io.write(`  access token:   in memory only, expires ${tokenSet.expiresAt}`)
    deps.io.write('  refresh token:  stored in the vault (not printed, not logged)')
    return 0
  } catch (error) {
    const failure = classifyOAuthError(error)
    const message = error instanceof Error ? error.message : String(error)
    deps.io.write(`login failed (${failure.kind}): ${redactor.redact(message)}`)
    if (failure.faultAction === 'safe_stopped') {
      deps.io.write('this needs a human decision; the process will not retry automatically')
    }
    return 1
  }
}

function format(message: string, fields?: Record<string, unknown>): string {
  if (fields === undefined || Object.keys(fields).length === 0) {
    return message
  }
  return `${message} ${JSON.stringify(fields)}`
}
