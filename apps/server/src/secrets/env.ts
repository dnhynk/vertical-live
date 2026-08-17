import { SECRET_NAMES, type SecretName, type SecretProvider } from './types.js'

/**
 * Environment-variable provider. It is the V1 stopgap until T3 ships the OS
 * credential vault provider: the process environment keeps secrets out of the
 * repository and out of the game DB, but it is not at-rest encrypted, so
 * `docs/ops/obs-setup.md` tells operators to set it per session.
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
