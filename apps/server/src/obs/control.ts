import { systemClock, type Clock } from '../clock.js'
import type { ObsConfig } from './config.js'
import { BROWSER_SOURCE_INPUT_KIND, BROWSER_SOURCE_REFRESH_PROPERTY } from './protocol.js'
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

export interface ObsControlOptions {
  readonly source: ObsRequester
  readonly config: ObsConfig
  readonly clock?: Clock
}

export class ObsControl {
  readonly #source: ObsRequester
  readonly #config: ObsConfig
  readonly #clock: Clock

  constructor(options: ObsControlOptions) {
    this.#source = options.source
    this.#config = options.config
    this.#clock = options.clock ?? systemClock
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
