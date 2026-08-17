import type { RendererLog } from '../read-model/log.js'

import ja from './ja.json'

/**
 * Japanese-first text resolution (spec §5.3). Snapshots carry i18n keys, never
 * sentences (contract `TextKeySchema`), so this is the only place a string
 * reaches the screen and no chat text can travel through it (spec §12.3).
 *
 * A key without an entry renders as the key itself. That is deliberate: the
 * world vocabulary arrives with the content director (T7/T14), and showing the
 * key makes a missing translation obvious instead of blanking a fixed slot.
 */

export const JA_NATIVE_REVIEW: string = ja.$meta.nativeReview

const STRINGS: Readonly<Record<string, string>> = ja.strings

export type TranslateParams = Readonly<Record<string, string | number>>

export type Translate = (key: string, params?: TranslateParams) => string

export function createTranslator(log: RendererLog): Translate {
  const reported = new Set<string>()
  return (key, params) => {
    const template = STRINGS[key]
    if (template === undefined) {
      if (!reported.has(key)) {
        reported.add(key)
        // Keys are `[a-z][a-z0-9]*(\.[a-z0-9_]+)+` by contract, so echoing one
        // into the log cannot leak wire content.
        log.warn('i18n_missing_key', key)
      }
      return key
    }
    if (params === undefined) return template
    return template.replace(/\{([a-z]+)\}/g, (match, name: string) => {
      const value = params[name]
      return value === undefined ? match : String(value)
    })
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
