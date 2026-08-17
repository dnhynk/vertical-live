import { describeOpsConfig } from '../ops/ops-config.js'

/**
 * Entry point for `npm run ops:config -w @vl/server`.
 *
 * Prints the resolved ops view (ports, URLs, paths, switches) as one JSON
 * document. `ops/windows/Start-VerticalLive.ps1` reads it instead of parsing
 * `config/default.json` itself, so the env overrides mean the same thing to the
 * launcher as they do to the server (review round 1, M1).
 */
try {
  process.stdout.write(`${JSON.stringify(describeOpsConfig())}\n`)
} catch (error) {
  process.stderr.write(`ops config unavailable: ${(error as Error).message}\n`)
  process.exitCode = 1
}
