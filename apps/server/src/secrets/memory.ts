import { SECRET_NAMES, type SecretName } from './types.js'
import type { SecretVault } from './vault.js'

/**
 * Test/CI vault. Values live in this process only, so it is the fallback used
 * where the OS credential vault does not exist (Linux CI) — never a production
 * store: the spec requires an at-rest encrypted store on the broadcasting host
 * (§10.2). `resolveSecretVault` refuses to hand this out unless the caller opts
 * in explicitly.
 */
export class InMemorySecretVault implements SecretVault {
  readonly source = 'in-memory (test only)'
  readonly #values = new Map<SecretName, string>()

  constructor(initial: Partial<Record<SecretName, string>> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      if (value !== undefined) {
        this.#values.set(assertKnown(name), value)
      }
    }
  }

  async get(name: SecretName): Promise<string | undefined> {
    return this.#values.get(assertKnown(name))
  }

  async set(name: SecretName, value: string): Promise<void> {
    if (value === '') {
      throw new Error(`refusing to store an empty secret: ${name}`)
    }
    this.#values.set(assertKnown(name), value)
  }

  async delete(name: SecretName): Promise<boolean> {
    return this.#values.delete(assertKnown(name))
  }

  /** Names currently held. Never returns values — diagnostics only. */
  storedNames(): SecretName[] {
    return [...this.#values.keys()]
  }
}

function assertKnown(name: string): SecretName {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) {
    throw new Error(`unknown secret name: ${name}`)
  }
  return name as SecretName
}
