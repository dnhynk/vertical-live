import { InMemorySecretVault } from './memory.js'
import { silentLogger, type Logger } from './redaction.js'
import { SecretVaultUnavailableError, type SecretVault } from './vault.js'
import { WindowsCredentialManagerVault } from './windows-credential-manager.js'

/**
 * Env flag that allows the in-memory vault off Windows. It exists for CI and
 * local non-Windows development; production hosts are Windows (D-2) and get the
 * Credential Manager vault, so a missing flag is an error rather than a silent
 * downgrade to an unencrypted store (spec §10.2).
 */
export const ALLOW_IN_MEMORY_VAULT_ENV = 'VL_ALLOW_IN_MEMORY_VAULT'

export interface ResolveSecretVaultOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly service?: string
  readonly logger?: Logger
}

export async function resolveSecretVault(
  options: ResolveSecretVaultOptions = {},
): Promise<SecretVault> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const logger = options.logger ?? silentLogger

  if (platform === 'win32') {
    const vault = await WindowsCredentialManagerVault.create({
      platform,
      ...(options.service === undefined ? {} : { service: options.service }),
    })
    logger.info('secret vault ready', { source: vault.source, service: vault.service })
    return vault
  }

  if (env[ALLOW_IN_MEMORY_VAULT_ENV] === '1' || env['VITEST'] === 'true') {
    logger.warn('using the in-memory secret vault: values are lost on exit', {
      platform,
      reason: env['VITEST'] === 'true' ? 'vitest' : ALLOW_IN_MEMORY_VAULT_ENV,
    })
    return new InMemorySecretVault()
  }

  throw new SecretVaultUnavailableError(
    'windows-credential-manager',
    `host platform is ${platform}; set ${ALLOW_IN_MEMORY_VAULT_ENV}=1 for a throwaway in-memory vault (tests/CI only)`,
  )
}
