import { SECRET_NAMES, type SecretName, type SecretProvider } from './types.js'

/**
 * Environment-variable provider — **development and test only** since T3.
 *
 * The process environment keeps secrets out of the repository and out of the
 * game DB, but it is not at-rest encrypted, so it does not satisfy spec §10.2.
 * The operational store is the OS credential vault
 * (`defaultSecretProvider()` / `resolveSecretVault()`); nothing constructs this
 * provider by default any more. Use it only where a caller injects it on
 * purpose: unit tests, and `obs:probe --fake`, which mints a synthetic password
 * for its own in-process fake server.
 */
export const SECRET_ENV_VARS: Readonly<Record<SecretName, string>> = {
  'obs.websocketPassword': 'VL_OBS_PASSWORD',
  'youtube.oauthRefreshToken': 'VL_YOUTUBE_REFRESH_TOKEN',
  'youtube.streamKey': 'VL_YOUTUBE_STREAM_KEY',
  'server.adminToken': 'VL_ADMIN_TOKEN',
  'server.simulatorToken': 'VL_SIMULATOR_TOKEN',
}

export class EnvSecretProvider implements SecretProvider {
  readonly source = 'env'
  readonly #env: NodeJS.ProcessEnv

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env
  }

  /** The env var a caller has to set, for error hints and setup docs. */
  static envVarFor(name: SecretName): string {
    return SECRET_ENV_VARS[name]
  }

  async get(name: SecretName): Promise<string | undefined> {
    if (!SECRET_NAMES.includes(name)) {
      throw new Error(`unknown secret name: ${name}`)
    }
    const value = this.#env[SECRET_ENV_VARS[name]]
    return value === undefined || value === '' ? undefined : value
  }
}
