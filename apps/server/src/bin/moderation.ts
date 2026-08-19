import { defaultSecretProvider } from '../secrets/resolve.js'
import { DEFAULT_HOST, resolvePort } from '../server.js'
import { runModerationCli } from '../supervisor/moderation-cli.js'

/**
 * Entry point for
 * `npm run moderation -w @vl/server -- --reason <token> [--note <text>] [--clear]`
 * (spec §12.3, TASK_SPECS §T22).
 */
const secrets = defaultSecretProvider()

const exitCode = await runModerationCli(process.argv.slice(2), {
  io: { write: (line) => process.stdout.write(`${line}\n`) },
  baseUrl: `http://${DEFAULT_HOST}:${resolvePort()}`,
  adminToken: () => secrets.get('server.adminToken'),
})
process.exitCode = exitCode
