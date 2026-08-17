import { runLoginCli } from '../youtube/auth/login-cli.js'

/** Entry point for `npm run auth:login -w @vl/server`. */
const exitCode = await runLoginCli(process.argv.slice(2), {
  io: { write: (line) => process.stdout.write(`${line}\n`) },
})
process.exitCode = exitCode
