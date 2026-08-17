import { silentLogger, type Logger } from './redaction.js'
import type { SecretName, SecretProvider } from './types.js'
import { type SecretVault } from './vault.js'
import { WindowsCredentialManagerVault } from './windows-credential-manager.js'

/**
 * Resolves the operational secret store (spec §10.2: OS credential vault or an
 * equivalent at-rest encrypted store).
 *
 * There is deliberately no environment switch here. Review round 1 showed that
 * an env flag turns "test-only fallback" into "one variable away from a
 * production process that keeps the refresh token in RAM and loses it on exit",
 * so the in-memory vault is reachable only by *injecting* it
 * (`InMemorySecretVault`), which no production entry point does. A host without
 * the OS vault fails loudly instead.
 */

export interface ResolveSecretVaultOptions {
  readonly platform?: NodeJS.Platform
  readonly service?: string
  readonly logger?: Logger
}

export async function resolveSecretVault(
  options: ResolveSecretVaultOptions = {},
): Promise<SecretVault> {
  const platform = options.platform ?? process.platform
  const logger = options.logger ?? silentLogger

  const vault = await WindowsCredentialManagerVault.create({
    platform,
    ...(options.service === undefined ? {} : { service: options.service }),
  })
  logger.info('secret vault ready', { source: vault.source, service: vault.service })
  return vault
}

/**
 * Read-only provider for callers that are constructed synchronously (the OBS
 * client and control surface). It resolves the vault on first read and caches
 * it, so a process that never needs a secret never touches the credential
 * store, and a process that does gets the vault rather than the environment.
 */
export function defaultSecretProvider(options: ResolveSecretVaultOptions = {}): SecretProvider {
  let pending: Promise<SecretVault> | undefined
  return {
    source: 'windows-credential-manager',
    async get(name: SecretName): Promise<string | undefined> {
      pending ??= resolveSecretVault(options)
      const vault = await pending
      return vault.get(name)
    },
  }
}
