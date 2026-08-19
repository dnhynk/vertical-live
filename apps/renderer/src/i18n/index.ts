import type { RendererLog } from '../read-model/log'

import ja from './ja.json'

/**
 * Japanese-first text resolution (spec §5.3). Snapshots carry i18n keys, never
 * sentences (contract `TextKeySchema`), so this is the only place a string
 * reaches the screen and no chat text can travel through it (spec §12.3).
 *
 * Every entry carries its own `nativeReview: "pending"` marker (TASK_SPECS
 * common rules, BOARD A-11) and its own short English alias where a slot shows
 * one after the Japanese (spec §5.1). No Japanese literal exists anywhere else
 * in the renderer — `japanese-source.test.ts` proves it over the sources.
 *
 * A key without an entry renders as the key itself. That is deliberate: the
 * content director (T7) owns the world vocabulary, so a value this file has not
 * caught up with must be visible as a missing key rather than blank out a fixed
 * slot.
 */

export interface JaEntry {
  readonly text: string
  /** Short English alias of spec §5.1, shown after the Japanese. */
  readonly en?: string
  readonly nativeReview: string
}

/** The resource itself, exported so tests assert against it instead of copies. */
export const JA_ENTRIES: Readonly<Record<string, JaEntry>> = ja.strings

export const JA_NATIVE_REVIEW: string = ja.$meta.nativeReview

export type TranslateParams = Readonly<Record<string, string | number>>

export type Translate = (key: string, params?: TranslateParams) => string

/**
 * The short English alias for a key, or `null` when the slot needs none.
 *
 * It takes the same parameters `Translate` does, because a line that has to say
 * the same thing in both languages has to carry the same values in both — the
 * consent notice names the two commands and the retention period, and neither
 * may be written twice (BOARD D-9, TASK_SPECS §T20c).
 */
export type Alias = (key: string, params?: TranslateParams) => string | null

function interpolate(template: string, params: TranslateParams | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{([a-z]+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

export function createTranslator(log: RendererLog): Translate {
  const reported = new Set<string>()
  return (key, params) => {
    const entry = JA_ENTRIES[key]
    if (entry === undefined) {
      if (!reported.has(key)) {
        reported.add(key)
        // Keys are `[a-z][a-z0-9]*(\.[a-z0-9_]+)+` by contract, so echoing one
        // into the log cannot leak wire content.
        log.warn('i18n_missing_key', key)
      }
      return key
    }
    return interpolate(entry.text, params)
  }
}

export function createAlias(): Alias {
  return (key, params) => {
    const en = JA_ENTRIES[key]?.en
    return en === undefined ? null : interpolate(en, params)
  }
}

/** Broadcast time base is JST (spec §5.3); the wire value stays UTC. */
export function formatJstTime(isoUtc: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoUtc))
}
