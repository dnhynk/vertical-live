import { defaultSecretProvider } from '../secrets/resolve.js'
import { DEFAULT_HOST, resolvePort } from '../server.js'
import { loadSupervisorConfig } from '../supervisor/config.js'
import { runKillCli } from '../supervisor/kill-cli.js'

/** Entry point for `npm run kill -w @vl/server -- [--reason <text>]`. */
const config = loadSupervisorConfig()
const secrets = defaultSecretProvider()

const exitCode = await runKillCli(process.argv.slice(2), {
  io: { write: (line) => process.stdout.write(`${line}\n`) },
  config,
  baseUrl: `http://${DEFAULT_HOST}:${resolvePort()}`,
  adminToken: () => secrets.get('server.adminToken'),
})
process.exitCode = exitCode
