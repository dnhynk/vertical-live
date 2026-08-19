import {
  ALLOWLISTED_COMMAND_ALIASES,
  CommandNameSchema,
  ConsentCommandNameSchema,
  type AllowlistedCommandName,
  type ConsentCommandName,
} from '@vl/contract'

import { normalizeText } from './normalize.js'

/**
 * The allowlist (spec §7.1). The alias *data* is the contract's
 * (`ALLOWLISTED_COMMAND_ALIASES` = the world commands of T1 plus the consent
 * commands of T20a/D-9); this module only decides how a message token is
 * matched against it, which is T6's half of the split.
 *
 * Both halves share **one** lookup so the collision check below covers them
 * together: no spelling may mean both "feed the creature" and "store my name".
 * What a match is allowed to do stays split — `matchAlias` returns the name and
 * the parser files a consent command in its own result shape.
 *
 * The table is built once at load time by pushing every alias through the same
 * `normalizeText` the message goes through, so `ＦＥＥＤ`, `feed` and `FEED`
 * land on one key without the data file listing spellings. The canonical name
 * is always accepted too.
 *
 * Nothing is folded for confusables here: see `normalize.ts` for why widening
 * the allowlist is the one direction that is never safe.
 */

const ALLOWLISTED_NAMES: readonly AllowlistedCommandName[] = [
  ...CommandNameSchema.options,
  ...ConsentCommandNameSchema.options,
]

const CONSENT_NAMES: ReadonlySet<string> = new Set(ConsentCommandNameSchema.options)

function buildLookup(): ReadonlyMap<string, AllowlistedCommandName> {
  const lookup = new Map<string, AllowlistedCommandName>()
  for (const name of ALLOWLISTED_NAMES) {
    const entry = ALLOWLISTED_COMMAND_ALIASES[name]
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
export function matchAlias(token: string): AllowlistedCommandName | null {
  return ALIAS_LOOKUP.get(token) ?? null
}

/** Narrows a matched name to the consent half of the allowlist (BOARD D-9). */
export function isConsentCommandName(name: AllowlistedCommandName): name is ConsentCommandName {
  return CONSENT_NAMES.has(name)
}

/** Every accepted spelling, normalized. Exposed for tests and metrics. */
export function aliasKeys(): readonly string[] {
  return [...ALIAS_LOOKUP.keys()]
}
