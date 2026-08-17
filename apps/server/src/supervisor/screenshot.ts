import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { systemClock, type Clock, type TimerHandle } from '../clock.js'
import type { ObsRequester } from '../obs/requester.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import type { ScreenshotConfig } from './config.js'

/**
 * Periodic diagnostic screenshots (spec §9.4).
 *
 * The spec is explicit about what these are *not*: "주기적 screenshot은 진단
 * 자료로 저장할 수 있지만 장면 hash 변화만으로 freeze를 판정하지 않는다. 정적
 * 장면은 오탐이고 배경만 움직이는 고장 화면은 미탐이기 때문이다."
 *
 * So this module writes files and nothing else. It computes no hash, exports no
 * status, and reports no `HealthSignal` — there is deliberately no path from a
 * screenshot to the aggregator, and `screenshot.test.ts` pins that. The freeze
 * evidence §9.4(4) actually uses is the renderer's own frame counter, applied
 * revision and WebGL context.
 *
 * The files land under `supervisor.screenshot.directory` with a bounded count
 * (spec §9.1 "용량 제한이 있는 로컬 rolling archive"). They show the broadcast
 * scene, which by §12.3 never contains raw chat or a viewer name.
 */

export interface ScreenshotFs {
  ensureDirectory(path: string): void
  list(path: string): readonly string[]
  remove(path: string): void
}

export const nodeScreenshotFs: ScreenshotFs = {
  ensureDirectory: (path) => {
    mkdirSync(path, { recursive: true })
  },
  list: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  remove: (path) => {
    rmSync(path, { force: true })
  },
}

export interface DiagnosticScreenshotOptions {
  readonly source: ObsRequester
  readonly config: ScreenshotConfig
  readonly clock?: Clock
  readonly logger?: Logger
  readonly fs?: ScreenshotFs
}

export interface ScreenshotResult {
  readonly saved: boolean
  readonly path: string | null
  readonly error: string | null
  readonly removed: readonly string[]
}

export class DiagnosticScreenshotRecorder {
  readonly #options: DiagnosticScreenshotOptions
  readonly #config: ScreenshotConfig
  readonly #clock: Clock
  readonly #logger: Logger
  readonly #fs: ScreenshotFs

  #running = false
  #timer: TimerHandle | undefined
  #lastResult: ScreenshotResult | null = null

  constructor(options: DiagnosticScreenshotOptions) {
    this.#options = options
    this.#config = options.config
    this.#clock = options.clock ?? systemClock
    this.#logger = options.logger ?? silentLogger
    this.#fs = options.fs ?? nodeScreenshotFs
  }

  get running(): boolean {
    return this.#running
  }

  /** Diagnostics only: never read by the aggregator or the state machine. */
  get lastResult(): ScreenshotResult | null {
    return this.#lastResult
  }

  start(): void {
    if (this.#running || !this.#config.enabled) return
    this.#running = true
    this.#scheduleNext()
  }

  stop(): void {
    if (!this.#running) return
    this.#running = false
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  /** One capture. Never rejects: a screenshot is diagnostics, not control. */
  async capture(): Promise<ScreenshotResult> {
    if (!this.#config.enabled) {
      return this.#record({ saved: false, path: null, error: 'disabled', removed: [] })
    }
    const directory = resolve(this.#config.directory)
    // `:` is not a legal path character on Windows (the primary host, BOARD D-2).
    const stamp = this.#clock.nowUtcIso().replace(/[:.]/g, '-')
    const path = join(directory, `screenshot-${stamp}.${this.#config.imageFormat}`)

    try {
      this.#fs.ensureDirectory(directory)
      await this.#options.source.call('SaveSourceScreenshot', {
        sourceName: this.#config.sourceName,
        imageFormat: this.#config.imageFormat,
        imageFilePath: path,
        imageWidth: this.#config.imageWidth,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#logger.warn('diagnostic screenshot failed', { error: message })
      return this.#record({ saved: false, path: null, error: message, removed: [] })
    }

    return this.#record({ saved: true, path, error: null, removed: this.#prune(directory) })
  }

  /** Keeps the newest `keep` files; names are UTC-stamped so they sort by age. */
  #prune(directory: string): readonly string[] {
    const files = this.#fs
      .list(directory)
      .filter((name) => name.startsWith('screenshot-'))
      .sort()
    const excess = files.length - this.#config.keep
    if (excess <= 0) return []
    const removed: string[] = []
    for (const name of files.slice(0, excess)) {
      try {
        this.#fs.remove(join(directory, name))
        removed.push(name)
      } catch (error) {
        this.#logger.warn('diagnostic screenshot prune failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return removed
  }

  #record(result: ScreenshotResult): ScreenshotResult {
    this.#lastResult = result
    return result
  }

  #scheduleNext(): void {
    if (!this.#running) return
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      void this.capture().then(() => {
        this.#scheduleNext()
      })
    }, this.#config.intervalMs)
  }
}
