import { runArchiveCli } from '../ops/archive/cli.js'

/**
 * Entry point for `npm run archive -w @vl/server -- [--apply] [--json]`.
 * Without `--apply` it is a dry run (spec §9.1 rolling archive, §11).
 */
process.exitCode = runArchiveCli(process.argv.slice(2), {
  io: { write: (line) => process.stdout.write(`${line}\n`) },
})
