import { COMMAND_ALIASES, CommandNameSchema } from '@vl/contract'
import { describe, expect, it } from 'vitest'

import { aliasKeys, matchAlias } from './aliases.js'
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
