import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadObsConfig } from '../obs/config.js'
import { DEFAULT_HOST, resolvePort } from '../server.js'
import { loadArchiveConfig } from './archive/config.js'
import { loadRendererStaticConfig } from './static-server.js'

/**
 * The resolved runtime view the Windows ops scripts need — ports, URLs, paths
 * and switches — produced by the **same loaders the server uses**.
 *
 * Review round 1, M1: `Start-VerticalLive.ps1` used to read `config/default.json`
 * itself, so the documented env overrides (`VL_OBS_PROCESS_ENABLED`,
 * `VL_RENDERER_STATIC_PORT`/`_HOST`, `VL_OBS_URL`, `VL_PORT`) did nothing for it.
 * The launcher could then refuse to start OBS that the operator had enabled, or
 * wait on a port other than the one the process it started is listening on.
 *
 * Re-implementing the precedence rules in PowerShell would just be a second
 * place for them to drift, so the script asks this process instead: it inherits
 * the environment, runs the real loaders, and prints one JSON document.
 */

export interface OpsConfigView {
  /** Repository root the config was read from; the script checks it matches. */
  readonly repoRoot: string
  readonly server: {
    readonly host: string
    readonly port: number
    readonly healthUrl: string
  }
  readonly renderer: {
    readonly host: string
    readonly port: number
    readonly url: string
    /** Absolute path of the directory that is served. */
    readonly directory: string
  }
  readonly obs: {
    readonly websocketUrl: string
    readonly websocketPort: number
    readonly processEnabled: boolean
    readonly executablePath: string
    /** `obs64.exe` — what the port owner is expected to be. */
    readonly executableName: string
  }
  readonly archive: {
    readonly enabled: boolean
  }
}

/** `config/default.json` at the repository root, from `src/ops/` or `dist/ops/`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../../../config/default.json', import.meta.url),
)

export interface DescribeOpsConfigOptions {
  readonly configPath?: string
  readonly env?: NodeJS.ProcessEnv
}

export function describeOpsConfig(options: DescribeOpsConfigOptions = {}): OpsConfigView {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH
  const env = options.env ?? process.env
  const loaderOptions = { configPath, env }

  const renderer = loadRendererStaticConfig(loaderOptions)
  const obs = loadObsConfig(loaderOptions)
  const archive = loadArchiveConfig(loaderOptions)
  const port = resolvePort(env)

  return {
    // `<repo>/config/default.json` → `<repo>`.
    repoRoot: resolve(dirname(configPath), '..'),
    server: {
      host: DEFAULT_HOST,
      port,
      healthUrl: `http://${DEFAULT_HOST}:${String(port)}/health`,
    },
    renderer: {
      host: renderer.host,
      port: renderer.port,
      url: `http://${renderer.host}:${String(renderer.port)}/`,
      directory: resolve(renderer.directory),
    },
    obs: {
      websocketUrl: obs.url,
      websocketPort: websocketPortOf(obs.url),
      processEnabled: obs.process.enabled,
      executablePath: obs.process.executablePath,
      executableName: basename(obs.process.executablePath),
    },
    archive: { enabled: archive.enabled },
  }
}

/** obs-websocket's port; `new URL` leaves it empty for a default-port URL. */
function websocketPortOf(url: string): number {
  const parsed = new URL(url)
  if (parsed.port !== '') return Number(parsed.port)
  return parsed.protocol === 'wss:' ? 443 : 80
}
