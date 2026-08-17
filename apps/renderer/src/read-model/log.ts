import type { IsoUtcInstant } from '@vl/contract'

import type { Clock } from './clock'

/**
 * Bounded diagnostic log for the `?mode=dev` panel and the browser console.
 *
 * `code` is a fixed identifier and `detail` is restricted to values the
 * renderer itself produced (counts, revisions, i18n keys, id-shaped strings).
 * Nothing read off the wire is ever logged verbatim, because the dev panel is
 * on screen and spec §12.3 keeps raw chat off the screen.
 */
export type LogLevel = 'info' | 'warn'

export interface LogEntry {
  readonly at: IsoUtcInstant
  readonly level: LogLevel
  readonly code: string
  readonly detail: string | null
}

const DEFAULT_CAPACITY = 200

export class RendererLog {
  readonly #clock: Clock
  readonly #capacity: number
  readonly #entries: LogEntry[] = []
  readonly #listeners = new Set<() => void>()
  #version = 0

  constructor(clock: Clock, capacity: number = DEFAULT_CAPACITY) {
    this.#clock = clock
    this.#capacity = capacity
  }

  push(level: LogLevel, code: string, detail: string | number | null = null): void {
    this.#entries.push({
      at: this.#clock.nowIso(),
      level,
      code,
      detail: detail === null ? null : String(detail),
    })
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity)
    }
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }

  /** Changes on every entry; `useSyncExternalStore` reads it. */
  get version(): number {
    return this.#version
  }

  info(code: string, detail?: string | number | null): void {
    this.push('info', code, detail ?? null)
  }

  warn(code: string, detail?: string | number | null): void {
    this.push('warn', code, detail ?? null)
  }

  entries(): readonly LogEntry[] {
    return this.#entries
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
