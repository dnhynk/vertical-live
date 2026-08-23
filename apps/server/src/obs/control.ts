import { systemClock, type Clock } from '../clock.js'
import { defaultSecretProvider, requireSecret, type SecretProvider } from '../secrets/index.js'
import type { ObsConfig } from './config.js'
import {
  BROWSER_SOURCE_INPUT_KIND,
  BROWSER_SOURCE_REFRESH_PROPERTY,
  CUSTOM_STREAM_SERVICE_TYPE,
} from './protocol.js'
import type { ObsRequester } from './requester.js'

/**
 * OBS control surface (spec §10.2: OBS is a compositing/encoding device, it does
 * not own game state). Every command verifies its own result before returning —
 * either by observing the state OBS reports afterwards, or, where v5 exposes no
 * such state, by pre-checking the target and letting the request's own
 * `RequestStatus` be the verification. Nothing here reports success it did not
 * observe.
 */

/** The command was refused before anything was sent to OBS. */
export class ObsCommandError extends Error {
  readonly reason: string

  constructor(reason: string, message: string) {
    super(message)
    this.name = 'ObsCommandError'
    this.reason = reason
  }
}

/** The request was accepted but OBS never reached the expected state in time. */
export class ObsCommandVerificationError extends Error {
  readonly expectation: string

  constructor(expectation: string, timeoutMs: number) {
    super(`obs did not reach expected state (${expectation}) within ${timeoutMs}ms`)
    this.name = 'ObsCommandVerificationError'
    this.expectation = expectation
  }
}

export interface StreamCommandResult {
  readonly outputActive: boolean
  /** False when OBS was already in the requested state and nothing was sent. */
  readonly changed: boolean
}

export interface BrowserSourceRefreshResult {
  readonly inputName: string
  readonly inputKind: string
}

export interface SceneSwitchResult {
  readonly sceneName: string
  readonly changed: boolean
}

/**
 * Outcome of a stream-service injection. It deliberately carries no key — only
 * whether one is now configured — so it stays safe to log (spec §10.2).
 */
export interface StreamServiceResult {
  readonly streamServiceType: string
  readonly server: string
  readonly keyConfigured: boolean
}

/**
 * Outcome of a Browser Source URL command. Like `StreamServiceResult` it names
 * no secret: `url` is the tokenless configured URL, and `tokenConfigured` says
 * whether OBS now holds one (spec §10.2).
 */
export interface BrowserSourceUrlResult {
  readonly inputName: string
  readonly url: string
  readonly tokenConfigured: boolean
}

export interface ObsControlOptions {
  readonly source: ObsRequester
  readonly config: ObsConfig
  readonly clock?: Clock
  readonly secrets?: SecretProvider
}

export class ObsControl {
  readonly #source: ObsRequester
  readonly #config: ObsConfig
  readonly #clock: Clock
  readonly #secrets: SecretProvider

  constructor(options: ObsControlOptions) {
    this.#source = options.source
    this.#config = options.config
    this.#clock = options.clock ?? systemClock
    // Default is the OS credential vault (spec §10.2); the env provider is a
    // development/test provider that has to be injected on purpose.
    this.#secrets = options.secrets ?? defaultSecretProvider()
  }

  /**
   * Pushes the RTMPS ingestion URL and the vault's stream key into OBS, so the
   * operator never types the key into the OBS UI (spec §10.2: the vault is the
   * stream key's system of record).
   *
   * Note what this does *not* claim: OBS persists whatever service settings it
   * holds into the active profile's `service.json`
   * (obs-studio `frontend/widgets/OBSBasic_Service.cpp`), so after injection the
   * key exists on the host's OBS profile directory as well as in the vault. It
   * is kept out of the repository, the game DB, logs, and the screen; removing
   * it on stop and locking down the profile directory is T17.
   *
   * Call this before `startStream()`.
   */
  async setStreamServiceFromVault(): Promise<StreamServiceResult> {
    const key = await requireSecret(
      this.#secrets,
      'youtube.streamKey',
      `store it with "npm run secrets -w @vl/server -- set youtube.streamKey" (development: set VL_YOUTUBE_STREAM_KEY and inject EnvSecretProvider). Spec §10.2, BOARD A-16: the vault is the stream key's system of record — it is never in the repository, the game DB, logs, or on screen. Once injected, OBS caches it in the active profile's service.json; clearing that on stop is T17`,
    )
    const server = this.#config.streamIngestUrl

    // OBS refuses this call outright while the output is running — "You cannot
    // change stream service settings while streaming." — and that refusal says
    // nothing about the output, so it reads like any other failure. The
    // start-up sequence died here five times running on the host on 2026-08-23
    // with nothing in the record about whether OBS was actually streaming.
    //
    // So the output is checked first, the way the rest of this module works: the
    // refusal names what it saw, and a failure that reaches a log now carries
    // the reason instead of OBS's generic sentence.
    // Already set? Then there is nothing to do, and saying so is what makes this
    // step survive a retry.
    //
    // The start-up sequence retries from the top when a later step fails, and a
    // later step failing is ordinary — `goLive` waits on YouTube seeing the
    // ingest as active. But by then this step's own effect is in place *and* the
    // encoder is running, and OBS refuses to set a stream service while
    // streaming. So a recoverable failure downstream turned into five
    // unrecoverable ones here, and the host could not broadcast (measured
    // 2026-08-23, TASK_SPECS §T38).
    const current = await this.#source.call('GetStreamServiceSettings')
    if (
      current.streamServiceType === CUSTOM_STREAM_SERVICE_TYPE &&
      readString(current.streamServiceSettings, 'server') === server &&
      readString(current.streamServiceSettings, 'key') === key
    ) {
      return { streamServiceType: CUSTOM_STREAM_SERVICE_TYPE, server, keyConfigured: true }
    }

    const before = await this.#source.call('GetStreamStatus')
    if (readBoolean(before, 'outputActive') === true) {
      throw new ObsCommandError(
        'output_active',
        'OBS is streaming and the stream service it has is not the one we want, so it cannot be changed. The output has to be stopped first (TASK_SPECS §T37).',
      )
    }

    await this.#source.call('SetStreamServiceSettings', {
      streamServiceType: CUSTOM_STREAM_SERVICE_TYPE,
      streamServiceSettings: { server, key },
    })

    // Verify by reading back, but never compare or surface the key itself:
    // only that OBS reports a non-empty one for the server we asked for.
    const applied = await this.#source.call('GetStreamServiceSettings')
    const appliedServer = readString(applied.streamServiceSettings, 'server')
    const appliedKey = readString(applied.streamServiceSettings, 'key')

    if (
      applied.streamServiceType !== CUSTOM_STREAM_SERVICE_TYPE ||
      appliedServer !== server ||
      appliedKey === undefined ||
      appliedKey === ''
    ) {
      throw new ObsCommandError(
        'stream_service_not_applied',
        `obs did not apply the stream service (type ${JSON.stringify(applied.streamServiceType)}, server ${JSON.stringify(appliedServer ?? null)}, key ${appliedKey === undefined || appliedKey === '' ? 'missing' : 'set'})`,
      )
    }

    return {
      streamServiceType: applied.streamServiceType,
      server,
      keyConfigured: true,
    }
  }

  /**
   * Removes the injected stream key from OBS again (BOARD A-16, the half
   * `docs/ops/obs-setup.md` §3 left to T17).
   *
   * OBS serialises the service settings it holds into the active profile's
   * `service.json`, so after a run the key sits on disk next to the profile.
   * Clearing it on stop means the window in which the host holds a copy is the
   * run itself, not "until someone remembers". The vault keeps its copy — it is
   * the system of record — so the next start injects the key again.
   *
   * Refuses while the output is active: emptying the key under a live stream
   * would leave OBS with no credentials for the next `StartStream` while
   * nothing looked wrong.
   */
  async clearStreamServiceKey(): Promise<StreamServiceResult> {
    const status = await this.#source.call('GetStreamStatus')
    if (status.outputActive) {
      throw new ObsCommandError(
        'stream_active',
        'refusing to clear the stream key while the output is active; stop the stream first',
      )
    }

    const server = this.#config.streamIngestUrl
    await this.#source.call('SetStreamServiceSettings', {
      streamServiceType: CUSTOM_STREAM_SERVICE_TYPE,
      streamServiceSettings: { server, key: '' },
    })

    const applied = await this.#source.call('GetStreamServiceSettings')
    const appliedKey = readString(applied.streamServiceSettings, 'key')
    if (appliedKey !== undefined && appliedKey !== '') {
      throw new ObsCommandError(
        'stream_service_not_cleared',
        'obs still reports a configured stream key after the clear',
      )
    }

    return { streamServiceType: applied.streamServiceType, server, keyConfigured: false }
  }

  /**
   * Points the renderer Browser Source at the loopback page **with the vault's
   * renderer token** (spec §10.2: `/ws/renderer` authenticates the upgrade).
   *
   * Same custody rule as the stream key (BOARD A-16): the operator never types
   * the token into OBS, `config/default.json` carries the tokenless URL, and the
   * token reaches OBS only at runtime. The result deliberately carries the
   * redacted URL — the token is not returned, and so cannot be logged by a
   * caller that logs the result (the mistake R-T8-2 found in the dev panel).
   */
  async setRendererSourceFromVault(): Promise<BrowserSourceUrlResult> {
    const token = await requireSecret(
      this.#secrets,
      'server.rendererToken',
      'store it with "npm run secrets -w @vl/server -- set server.rendererToken". Spec §10.2, BOARD A-16: the vault is the token\'s system of record — it is never in the repository, the game DB, logs, or on screen. OBS caches the URL it is given in the scene-collection JSON; clearRendererSourceToken() removes it on stop',
    )
    const name = this.#config.browserSourceName
    await this.#assertBrowserSource(name)

    const url = new URL(this.#config.browserSourceUrl)
    url.searchParams.set('token', token)
    await this.#source.call('SetInputSettings', {
      inputName: name,
      inputSettings: { url: url.toString() },
    })

    const applied = await this.#readBrowserSourceUrl(name)
    if (applied === undefined || applied.searchParams.get('token') !== token) {
      throw new ObsCommandError(
        'browser_source_not_applied',
        `obs did not apply the renderer URL on ${JSON.stringify(name)}`,
      )
    }

    return { inputName: name, url: this.#config.browserSourceUrl, tokenConfigured: true }
  }

  /**
   * Puts the tokenless URL back, so OBS's scene-collection JSON stops holding
   * the renderer token once the run is over (BOARD A-16, `docs/ops/obs-setup.md`).
   */
  async clearRendererSourceToken(): Promise<BrowserSourceUrlResult> {
    const name = this.#config.browserSourceName
    await this.#assertBrowserSource(name)

    await this.#source.call('SetInputSettings', {
      inputName: name,
      inputSettings: { url: this.#config.browserSourceUrl },
    })

    const applied = await this.#readBrowserSourceUrl(name)
    if (applied !== undefined && applied.searchParams.has('token')) {
      throw new ObsCommandError(
        'browser_source_not_cleared',
        `obs still reports a token on ${JSON.stringify(name)} after the clear`,
      )
    }

    return { inputName: name, url: this.#config.browserSourceUrl, tokenConfigured: false }
  }

  /** Idempotent: an already-running output is reported, not re-started. */
  async startStream(): Promise<StreamCommandResult> {
    return this.#setStreamActive(true)
  }

  async stopStream(): Promise<StreamCommandResult> {
    return this.#setStreamActive(false)
  }

  /**
   * Presses obs-browser's "Refresh cache of current page" button
   * (`refreshnocache`) on the renderer Browser Source.
   *
   * v5 exposes no post-refresh state to read back, so verification is: the input
   * exists, it really is a `browser_source`, and `PressInputPropertiesButton`
   * returned `RequestStatus` success (obs-websocket-js throws otherwise).
   */
  async refreshBrowserSource(inputName?: string): Promise<BrowserSourceRefreshResult> {
    const name = inputName ?? this.#config.browserSourceName
    const inputKind = await this.#assertBrowserSource(name)

    await this.#source.call('PressInputPropertiesButton', {
      inputName: name,
      propertyName: BROWSER_SOURCE_REFRESH_PROPERTY,
    })

    return { inputName: name, inputKind }
  }

  /** Switches the program scene and waits until OBS reports it as current. */
  async switchScene(sceneName: string): Promise<SceneSwitchResult> {
    const { scenes, currentProgramSceneName } = await this.#source.call('GetSceneList')

    const known = scenes.some((entry) => readString(entry, 'sceneName') === sceneName)
    if (!known) {
      throw new ObsCommandError(
        'scene_not_found',
        `no OBS scene named ${JSON.stringify(sceneName)}`,
      )
    }
    if (currentProgramSceneName === sceneName) {
      return { sceneName, changed: false }
    }

    await this.#source.call('SetCurrentProgramScene', { sceneName })
    await this.#waitUntil(async () => {
      const current = await this.#source.call('GetCurrentProgramScene')
      return current.sceneName === sceneName
    }, `program scene = ${sceneName}`)

    return { sceneName, changed: true }
  }

  /**
   * Shared by the refresh and both URL commands: the input must exist and be a
   * Browser Source. Returns the kind OBS reported, for callers that echo it.
   */
  async #assertBrowserSource(name: string): Promise<string> {
    const { inputs } = await this.#source.call('GetInputList')
    const input = inputs.find((entry) => readString(entry, 'inputName') === name)
    if (input === undefined) {
      throw new ObsCommandError('input_not_found', `no OBS input named ${JSON.stringify(name)}`)
    }
    const inputKind = readString(input, 'inputKind') ?? ''
    const unversionedInputKind = readString(input, 'unversionedInputKind') ?? ''
    if (
      inputKind !== BROWSER_SOURCE_INPUT_KIND &&
      unversionedInputKind !== BROWSER_SOURCE_INPUT_KIND
    ) {
      throw new ObsCommandError(
        'not_a_browser_source',
        `input ${JSON.stringify(name)} is kind ${JSON.stringify(inputKind)}, not ${BROWSER_SOURCE_INPUT_KIND}`,
      )
    }
    return inputKind === '' ? unversionedInputKind : inputKind
  }

  async #readBrowserSourceUrl(name: string): Promise<URL | undefined> {
    const applied = await this.#source.call('GetInputSettings', { inputName: name })
    const value = readString(applied.inputSettings, 'url')
    if (value === undefined) return undefined
    try {
      return new URL(value)
    } catch {
      return undefined
    }
  }

  async #setStreamActive(active: boolean): Promise<StreamCommandResult> {
    const before = await this.#source.call('GetStreamStatus')
    if (before.outputActive === active) {
      return { outputActive: active, changed: false }
    }

    await this.#source.call(active ? 'StartStream' : 'StopStream')
    await this.#waitUntil(
      async () => {
        const status = await this.#source.call('GetStreamStatus')
        return status.outputActive === active
      },
      `outputActive = ${String(active)}`,
    )

    return { outputActive: active, changed: true }
  }

  /**
   * Polls a predicate until it holds or `obs.commandVerifyTimeoutMs` elapses.
   * The deadline is measured on the monotonic clock (spec §10.2).
   */
  async #waitUntil(predicate: () => Promise<boolean>, expectation: string): Promise<void> {
    const deadlineMs = this.#clock.monotonicMs() + this.#config.commandVerifyTimeoutMs
    for (;;) {
      if (await predicate()) {
        return
      }
      if (this.#clock.monotonicMs() >= deadlineMs) {
        throw new ObsCommandVerificationError(expectation, this.#config.commandVerifyTimeoutMs)
      }
      await this.#sleep(this.#config.commandVerifyIntervalMs)
    }
  }

  async #sleep(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#clock.setTimeout(resolve, delayMs)
    })
  }
}

/** OBS request payloads are free-form JSON; read the fields we need defensively. */
function readBoolean(value: unknown, key: string): boolean | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'boolean' ? field : undefined
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}
