import { ObsClient } from '../obs/client.js'
import { loadObsConfig } from '../obs/config.js'
import { ObsControl } from '../obs/control.js'
import { defaultSecretProvider } from '../secrets/resolve.js'

/**
 * Entry point for `npm run obs:clear -w @vl/server`.
 *
 * Takes the two injected secrets back out of OBS: the stream key it caches in
 * the active profile's `service.json` and the renderer token it caches in the
 * scene-collection JSON (BOARD A-16, `docs/ops/obs-setup.md` §3). The supervisor
 * does this on `safe_stopped`; this command is for the ordinary stop, where the
 * process simply exits.
 *
 * It refuses while the output is active, prints no secret, and needs OBS to be
 * running — clearing what OBS holds in memory is the only way to change what it
 * writes to disk.
 */
const config = loadObsConfig()
const client = new ObsClient({ config, secrets: defaultSecretProvider() })
const control = new ObsControl({ source: client, config, secrets: defaultSecretProvider() })

try {
  await client.connect()
  const service = await control.clearStreamServiceKey()
  const source = await control.clearRendererSourceToken()
  process.stdout.write(
    `${JSON.stringify({ streamKeyConfigured: service.keyConfigured, rendererTokenConfigured: source.tokenConfigured, browserSource: source.inputName })}\n`,
  )
} catch (error) {
  process.stderr.write(`obs clear failed: ${(error as Error).message}\n`)
  process.exitCode = 1
} finally {
  await client.disconnect()
}
