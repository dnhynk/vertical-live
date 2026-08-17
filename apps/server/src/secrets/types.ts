/**
 * Secret access contract (spec §10.2). Secrets live in an OS credential vault or
 * an equivalent at-rest encrypted store — never in the repository, the game DB,
 * logs, or on screen. T3 replaces the env implementation with the Windows
 * Credential Manager one; every consumer only ever sees this interface.
 */

/** The secret set spec §10.2 enumerates. Names are stable across providers. */
export const SECRET_NAMES = [
  'obs.websocketPassword',
  'youtube.oauthRefreshToken',
  'youtube.streamKey',
  'server.adminToken',
  'server.simulatorToken',
] as const

export type SecretName = (typeof SECRET_NAMES)[number]

export interface SecretProvider {
  /**
   * Human-readable provider identity for logs. Must never contain a secret
   * value (e.g. `env`, `windows-credential-manager`).
   */
  readonly source: string
  /** Resolves to `undefined` when the secret is not configured. */
  get(name: SecretName): Promise<string | undefined>
}

/**
 * Thrown when a required secret is absent. The message names the secret and the
 * provider, never a value — a missing-secret error must stay safe to log.
 */
export class MissingSecretError extends Error {
  readonly secretName: SecretName
  readonly source: string

  constructor(secretName: SecretName, source: string, hint?: string) {
    super(`secret not configured: ${secretName} (provider: ${source})${hint ? ` — ${hint}` : ''}`)
    this.name = 'MissingSecretError'
    this.secretName = secretName
    this.source = source
  }
}

export async function requireSecret(
  provider: SecretProvider,
  name: SecretName,
  hint?: string,
): Promise<string> {
  const value = await provider.get(name)
  if (value === undefined || value === '') {
    throw new MissingSecretError(name, provider.source, hint)
  }
  return value
}
