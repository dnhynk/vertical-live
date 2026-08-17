import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { REQUIRED_SCOPES } from '../scopes.js'

/**
 * YouTube auth settings. Non-secret values live in `config/default.json`
 * (`youtube.auth`) with env overrides, matching the shared convention in
 * `docs/tasks/TASK_SPECS.md` 공통 규약. The OAuth client id/secret never live in
 * the repository: they come from the environment or from the client-secrets
 * JSON the operator downloads from Google Cloud console (git-ignored).
 *
 * Values the spec does not fix are listed in `provisional` (BOARD A-15) and are
 * replaced by the Gate 0/2 approved numbers; they are not pass/fail lines.
 */

export interface YouTubeAuthConfig {
  /** Credential Manager service the vault groups entries under. */
  readonly credentialService: string
  /** Loopback address the login listener binds. */
  readonly loopbackHost: string
  /** How long the login CLI waits for the browser redirect. */
  readonly loginTimeoutMs: number
  /** Refresh the access token this long before it expires. */
  readonly accessTokenRefreshSkewMs: number
  readonly scopes: readonly string[]
  readonly provisional: readonly string[]
}

export interface OAuthClientCredentials {
  readonly clientId: string
  readonly clientSecret?: string
}

/** `config/default.json` at the repository root, from `src/…` or `dist/…`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../../config/default.json', import.meta.url),
)

export const CLIENT_ID_ENV = 'VL_GOOGLE_CLIENT_ID'
export const CLIENT_SECRET_ENV = 'VL_GOOGLE_CLIENT_SECRET'
export const CLIENT_SECRETS_FILE_ENV = 'VL_GOOGLE_CLIENT_SECRETS_FILE'

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(`invalid youtube auth config: ${message}`)
    this.name = 'AuthConfigError'
  }
}

export interface LoadAuthConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function loadYouTubeAuthConfig(options: LoadAuthConfigOptions = {}): YouTubeAuthConfig {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env
  const section = readSection(configPath, 'auth')

  const scopes = readStringArray(section['scopes'], 'youtube.auth.scopes')
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope))
  if (missing.length > 0) {
    throw new AuthConfigError(`youtube.auth.scopes is missing ${missing.join(', ')}`)
  }

  const loopbackHost =
    env['VL_OAUTH_LOOPBACK_HOST'] ??
    readString(section['loopbackHost'], 'youtube.auth.loopbackHost')
  if (loopbackHost !== '127.0.0.1' && loopbackHost !== '::1') {
    throw new AuthConfigError(`loopbackHost must be a loopback address, got ${loopbackHost}`)
  }

  return Object.freeze({
    credentialService: readString(section['credentialService'], 'youtube.auth.credentialService'),
    loopbackHost,
    loginTimeoutMs: readPositiveInt(section['loginTimeoutMs'], 'youtube.auth.loginTimeoutMs'),
    accessTokenRefreshSkewMs: readPositiveInt(
      section['accessTokenRefreshSkewMs'],
      'youtube.auth.accessTokenRefreshSkewMs',
    ),
    scopes: Object.freeze(scopes),
    provisional: Object.freeze(readStringArray(section['provisional'], 'youtube.auth.provisional')),
  })
}

/**
 * Reads the OAuth client id/secret. Order: explicit env vars, then the
 * client-secrets JSON file named by `VL_GOOGLE_CLIENT_SECRETS_FILE` (the
 * `installed` block Google Cloud console downloads).
 */
export function loadOAuthClientCredentials(
  env: NodeJS.ProcessEnv = process.env,
): OAuthClientCredentials {
  const clientId = env[CLIENT_ID_ENV]
  if (clientId !== undefined && clientId !== '') {
    const clientSecret = env[CLIENT_SECRET_ENV]
    return {
      clientId,
      ...(clientSecret === undefined || clientSecret === '' ? {} : { clientSecret }),
    }
  }

  const file = env[CLIENT_SECRETS_FILE_ENV]
  if (file === undefined || file === '') {
    throw new AuthConfigError(
      `set ${CLIENT_ID_ENV} (and ${CLIENT_SECRET_ENV}) or ${CLIENT_SECRETS_FILE_ENV}; see docs/ops/youtube-auth-setup.md`,
    )
  }
  return readClientSecretsFile(file)
}

export function readClientSecretsFile(path: string): OAuthClientCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new AuthConfigError(
      `cannot read client secrets file ${path}: ${(error as Error).message}`,
    )
  }
  const root = asObject(parsed, 'client secrets')
  const installed = root['installed'] ?? root['web']
  const block = asObject(installed, 'client secrets .installed')
  const clientId = block['client_id']
  if (typeof clientId !== 'string' || clientId === '') {
    throw new AuthConfigError(`client secrets file ${path} has no installed.client_id`)
  }
  const clientSecret = block['client_secret']
  return {
    clientId,
    ...(typeof clientSecret === 'string' && clientSecret !== '' ? { clientSecret } : {}),
  }
}

function readSection(configPath: string, name: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new AuthConfigError(`cannot read ${configPath}: ${(error as Error).message}`)
  }
  const youtube = asObject(asObject(parsed, 'root')['youtube'], 'youtube')
  return asObject(youtube[name], `youtube.${name}`)
}

/** Shared by the quota config loader so both read the same file the same way. */
export function readYouTubeSection(
  name: string,
  options: LoadAuthConfigOptions = {},
): Record<string, unknown> {
  return readSection(options.configPath ?? DEFAULT_CONFIG_PATH, name)
}

export function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthConfigError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuthConfigError(`${label} must be a non-empty string`)
  }
  return value
}

export function readPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AuthConfigError(`${label} must be a positive integer`)
  }
  return value
}

export function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AuthConfigError(`${label} must be an array of strings`)
  }
  return value as string[]
}
