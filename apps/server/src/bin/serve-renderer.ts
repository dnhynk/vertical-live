import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { loadRendererStaticConfig, startRendererStaticServer } from '../ops/static-server.js'

/**
 * Entry point for `npm run serve:renderer -w @vl/server`.
 *
 * Serves the built renderer on loopback for the OBS Browser Source. It is the
 * second process the logon autostart brings up (TASK_SPECS §T17); the
 * authoritative server is `npm run start -w @vl/server`.
 */
const config = loadRendererStaticConfig()
const directory = resolve(config.directory)

if (!existsSync(directory)) {
  process.stderr.write(
    `renderer build not found at ${directory}\nrun "npm run build -w @vl/renderer" first\n`,
  )
  process.exit(1)
}

const started = await startRendererStaticServer({
  config,
  logger: {
    debug: () => {},
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  },
})

process.stdout.write(`@vl/server renderer static serving ${directory} at ${started.url}\n`)

function write(level: string, message: string, fields?: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), level, message, ...fields })}\n`,
  )
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void started.close().then(() => {
      process.exit(0)
    })
  })
}
