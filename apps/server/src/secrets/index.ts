export { SECRET_NAMES, MissingSecretError, requireSecret } from './types.js'
export type { SecretName, SecretProvider } from './types.js'
export { EnvSecretProvider, SECRET_ENV_VARS } from './env.js'
export { SecretVaultError, SecretVaultUnavailableError } from './vault.js'
export type { SecretVault } from './vault.js'
export { InMemorySecretVault } from './memory.js'
export {
  DEFAULT_CREDENTIAL_SERVICE,
  WindowsCredentialManagerVault,
} from './windows-credential-manager.js'
export type { CredentialEntry, CredentialEntryFactory } from './windows-credential-manager.js'
export { ALLOW_IN_MEMORY_VAULT_ENV, resolveSecretVault } from './resolve.js'
export type { ResolveSecretVaultOptions } from './resolve.js'
export {
  MIN_REDACTABLE_LENGTH,
  REDACTED,
  SecretRedactor,
  createRedactingLogger,
  redactValues,
  silentLogger,
} from './redaction.js'
export type { LogFields, LogValue, Logger } from './redaction.js'
