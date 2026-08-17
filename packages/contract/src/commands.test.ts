import { describe, expect, it } from 'vitest'

import { COMMAND_ALIASES, CommandNameSchema, CommandRefSchema } from './commands.js'

/**
 * The V1 command vocabulary of spec §7.1. This module is data plus types: the
 * normalization and allowlist matching that consume the table are T6.
 */

describe('CommandName', () => {
  it('is exactly the six V1 free commands', () => {
    expect(CommandNameSchema.options).toEqual(['FEED', 'PLAY', 'PET', 'VOTE_A', 'VOTE_B', 'VOTE_C'])
  })
})

describe('COMMAND_ALIASES', () => {
  it('has a row for every command and no extra row', () => {
    expect(Object.keys(COMMAND_ALIASES).sort()).toEqual([...CommandNameSchema.options].sort())
  })

  it('carries the §7.1 examples for the three care commands', () => {
    expect(COMMAND_ALIASES.FEED).toMatchObject({ ja: ['ごはん'], icons: ['🍙'], en: ['FEED'] })
    expect(COMMAND_ALIASES.PLAY).toMatchObject({ ja: ['あそぶ'], icons: ['🎾'], en: ['PLAY'] })
    expect(COMMAND_ALIASES.PET).toMatchObject({ ja: ['なでる'], icons: ['❤️'], en: ['PET'] })
  })

  it('carries the bare letters for the vote commands and invents no icon', () => {
    expect(COMMAND_ALIASES.VOTE_A).toMatchObject({ ja: [], icons: [], en: ['A'] })
    expect(COMMAND_ALIASES.VOTE_B).toMatchObject({ ja: [], icons: [], en: ['B'] })
    expect(COMMAND_ALIASES.VOTE_C).toMatchObject({ ja: [], icons: [], en: ['C'] })
  })

  it('claims no native review before a native speaker has signed off (spec §5.3)', () => {
    for (const entry of Object.values(COMMAND_ALIASES)) {
      expect(entry.nativeReview).toBe('pending')
    }
  })

  it('has at least one alias per command and no blank alias', () => {
    for (const [name, entry] of Object.entries(COMMAND_ALIASES)) {
      const aliases = [...entry.ja, ...entry.icons, ...entry.en]
      expect(aliases.length, name).toBeGreaterThan(0)
      for (const alias of aliases) expect(alias.trim(), name).toBe(alias)
      expect(new Set(aliases).size, name).toBe(aliases.length)
    }
  })

  it('maps every alias to exactly one command', () => {
    const owners = new Map<string, string>()
    for (const [name, entry] of Object.entries(COMMAND_ALIASES)) {
      for (const alias of [...entry.ja, ...entry.icons, ...entry.en]) {
        expect(owners.get(alias), `${alias} is ambiguous`).toBeUndefined()
        owners.set(alias, name)
      }
    }
  })
})

describe('CommandRef', () => {
  it('accepts a command with and without an argument token', () => {
    expect(CommandRefSchema.parse({ name: 'FEED', argument: null })).toEqual({
      name: 'FEED',
      argument: null,
    })
    expect(CommandRefSchema.safeParse({ name: 'VOTE_A', argument: 'choice_a' }).success).toBe(true)
  })

  it('refuses a chat line smuggled in as an argument', () => {
    expect(
      CommandRefSchema.safeParse({ name: 'FEED', argument: 'ごはん あげて！ https://x.invalid' })
        .success,
    ).toBe(false)
  })

  it('refuses a command outside the allowlist', () => {
    expect(CommandRefSchema.safeParse({ name: 'REVIVE', argument: null }).success).toBe(false)
  })
})
