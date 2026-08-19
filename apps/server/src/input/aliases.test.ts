import { COMMAND_ALIASES, CommandNameSchema } from '@vl/contract'
import { describe, expect, it } from 'vitest'

import { aliasKeys, isConsentCommandName, matchAlias } from './aliases.js'
import { normalizeText } from './normalize.js'

describe('command allowlist', () => {
  it('maps every alias the contract declares, in every spelling', () => {
    for (const name of CommandNameSchema.options) {
      const entry = COMMAND_ALIASES[name]
      for (const spelling of [name, ...entry.ja, ...entry.icons, ...entry.en]) {
        expect(matchAlias(normalizeText(spelling).normalized), spelling).toBe(name)
      }
    }
  })

  it('maps the aliases spec §7.1 lists for FEED', () => {
    for (const spelling of ['ごはん', '🍙', 'FEED', 'feed']) {
      expect(matchAlias(normalizeText(spelling).normalized), spelling).toBe('FEED')
    }
  })

  it('does not accept a token that merely contains an alias', () => {
    expect(matchAlias('feeder')).toBeNull()
    expect(matchAlias('feeeed')).toBeNull()
    expect(matchAlias('ごはんだ')).toBeNull()
  })

  it('does not accept a confusable spelling as a command', () => {
    // Cyrillic а: folding is only ever applied to the rejection checks, so
    // widening the allowlist is impossible by construction.
    expect(matchAlias(normalizeText('а').normalized)).toBeNull()
    expect(matchAlias(normalizeText('ғeed').normalized)).toBeNull()
  })

  it('has no duplicate keys across commands', () => {
    const keys = aliasKeys()
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('consent aliases (BOARD D-9)', () => {
  it('matches the consent spellings and narrows them', () => {
    for (const [token, name] of [
      ['なのる', 'JOIN'],
      ['join', 'JOIN'],
      ['なまえけす', 'LEAVE'],
      ['leave', 'LEAVE'],
    ] as const) {
      const matched = matchAlias(normalizeText(token).normalized)
      expect(matched).toBe(name)
      expect(matched !== null && isConsentCommandName(matched)).toBe(true)
    }
  })

  it('does not narrow a world command to a consent one', () => {
    for (const token of ['feed', 'ごはん', 'a']) {
      const matched = matchAlias(normalizeText(token).normalized)
      expect(matched).not.toBeNull()
      expect(matched !== null && isConsentCommandName(matched)).toBe(false)
    }
  })

  it('shares one lookup, so no spelling can mean both a care and a consent command', () => {
    // The collision check in `buildLookup` covers both halves together; this
    // asserts the property the check produces.
    const keys = aliasKeys()
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain(normalizeText('なのる').normalized)
    expect(keys).toContain(normalizeText('ごはん').normalized)
  })
})
