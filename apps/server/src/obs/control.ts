import { systemClock, type Clock } from '../clock.js'
import { EnvSecretProvider } from '../secrets/env.js'
import { requireSecret, type SecretProvider } from '../secrets/index.js'
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
    this.#secrets = options.secrets ?? new EnvSecretProvider()
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
      `set ${EnvSecretProvider.envVarFor('youtube.streamKey')} (spec §10.2, BOARD A-16: the vault is the stream key's system of record — it is never in the repository, the game DB, logs, or on screen. Once injected, OBS caches it in the active profile's service.json; clearing that on stop is T17)`,
    )
    const server = this.#config.streamIngestUrl

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

    await this.#source.call('PressInputPropertiesButton', {
      inputName: name,
      propertyName: BROWSER_SOURCE_REFRESH_PROPERTY,
    })

    return { inputName: name, inputKind: inputKind === '' ? unversionedInputKind : inputKind }
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
function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}
