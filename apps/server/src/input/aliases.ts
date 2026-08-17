import { COMMAND_ALIASES, CommandNameSchema, type CommandName } from '@vl/contract'

import { normalizeText } from './normalize.js'

/**
 * The allowlist (spec §7.1). The alias *data* is the contract's
 * (`COMMAND_ALIASES`, T1); this module only decides how a message token is
 * matched against it, which is T6's half of the split.
 *
 * The table is built once at load time by pushing every alias through the same
 * `normalizeText` the message goes through, so `ＦＥＥＤ`, `feed` and `FEED`
 * land on one key without the data file listing spellings. The canonical name
 * is always accepted too.
 *
 * Nothing is folded for confusables here: see `normalize.ts` for why widening
 * the allowlist is the one direction that is never safe.
 */

function buildLookup(): ReadonlyMap<string, CommandName> {
  const lookup = new Map<string, CommandName>()
  for (const name of CommandNameSchema.options) {
    const entry = COMMAND_ALIASES[name]
    const spellings = [name, ...entry.ja, ...entry.icons, ...entry.en]
    for (const spelling of spellings) {
      const key = normalizeText(spelling).normalized
      if (key.length === 0) {
        throw new Error(`command alias for ${name} normalizes to nothing`)
      }
      const existing = lookup.get(key)
      if (existing !== undefined && existing !== name) {
        throw new Error(`command alias collision between ${existing} and ${name}`)
      }
      lookup.set(key, name)
    }
  }
  return lookup
}

const ALIAS_LOOKUP = buildLookup()

/** Canonical command for a normalized token, or `null` when it is not one. */
export function matchAlias(token: string): CommandName | null {
  return ALIAS_LOOKUP.get(token) ?? null
}

/** Every accepted spelling, normalized. Exposed for tests and metrics. */
export function aliasKeys(): readonly string[] {
  return [...ALIAS_LOOKUP.keys()]
}
