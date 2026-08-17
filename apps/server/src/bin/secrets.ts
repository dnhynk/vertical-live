import { runSecretsCli } from '../secrets/cli.js'
import { resolveSecretVault } from '../secrets/resolve.js'
import { loadYouTubeAuthConfig } from '../youtube/auth/config.js'

/** Entry point for `npm run secrets -w @vl/server -- <command>`. */
const config = loadYouTubeAuthConfig()
const vault = await resolveSecretVault({ service: config.credentialService })

const exitCode = await runSecretsCli(process.argv.slice(2), {
  vault,
  io: {
    write: (line) => process.stdout.write(`${line}\n`),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer)
      }
      return Buffer.concat(chunks).toString('utf8')
    },
  },
})
process.exitCode = exitCode
