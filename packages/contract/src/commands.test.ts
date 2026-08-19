import { describe, expect, it } from 'vitest'

import {
  ALLOWLISTED_COMMAND_ALIASES,
  AnyCommandRefSchema,
  COMMAND_ALIASES,
  CONSENT_COMMAND_ALIASES,
  CommandNameSchema,
  CommandRefSchema,
  ConsentCommandNameSchema,
  ConsentCommandRefSchema,
  isConsentCommandRef,
} from './commands.js'

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

  it('refuses a consent command, so no world path can be handed one', () => {
    // `JOIN` and `LEAVE` are allowlisted commands (spec §7.1) that change no
    // world state, and this is where that separation is enforced (BOARD D-9).
    expect(CommandRefSchema.safeParse({ name: 'JOIN', argument: null }).success).toBe(false)
    expect(CommandRefSchema.safeParse({ name: 'LEAVE', argument: null }).success).toBe(false)
  })
})

describe('ConsentCommandName (BOARD D-9)', () => {
  it('is exactly the two consent commands', () => {
    expect(ConsentCommandNameSchema.options).toEqual(['JOIN', 'LEAVE'])
  })

  it('shares no name with the commands that move the world', () => {
    // The split is the invariant: a consent decision must not be able to reach
    // a tally, a staging effect or a growth step (TASK_SPECS §T20a).
    const world = new Set<string>(CommandNameSchema.options)
    for (const name of ConsentCommandNameSchema.options) expect(world.has(name)).toBe(false)
  })
})

describe('CONSENT_COMMAND_ALIASES', () => {
  it('has a row for every consent command and no extra row', () => {
    expect(Object.keys(CONSENT_COMMAND_ALIASES).sort()).toEqual(
      [...ConsentCommandNameSchema.options].sort(),
    )
  })

  it('spells consent and withdrawal in Japanese and English', () => {
    expect(CONSENT_COMMAND_ALIASES.JOIN).toMatchObject({ ja: ['なのる'], en: ['JOIN'] })
    expect(CONSENT_COMMAND_ALIASES.LEAVE).toMatchObject({ ja: ['なまえけす'], en: ['LEAVE'] })
  })

  it('gives neither command an icon alias', () => {
    // One emoji is the easiest thing to send by accident and these two commands
    // start and stop storing personal data (spec §12.4, BOARD D-9).
    expect(CONSENT_COMMAND_ALIASES.JOIN.icons).toEqual([])
    expect(CONSENT_COMMAND_ALIASES.LEAVE.icons).toEqual([])
  })

  it('claims no native review before a native speaker has signed off (spec §5.3)', () => {
    for (const entry of Object.values(CONSENT_COMMAND_ALIASES)) {
      expect(entry.nativeReview).toBe('pending')
    }
  })

  it('keeps consent and withdrawal far enough apart that no typo swaps them', () => {
    // One of the two stores a name and the other deletes it, so they must not be
    // one character apart.
    const [join] = CONSENT_COMMAND_ALIASES.JOIN.ja
    const [leave] = CONSENT_COMMAND_ALIASES.LEAVE.ja
    expect(join).not.toBe(leave)
    const shared = [...(join ?? '')].filter((character) => (leave ?? '').includes(character))
    expect(shared.length).toBeLessThan(2)
  })
})

describe('ALLOWLISTED_COMMAND_ALIASES', () => {
  it('is the world table plus the consent table', () => {
    expect(Object.keys(ALLOWLISTED_COMMAND_ALIASES).sort()).toEqual(
      [...CommandNameSchema.options, ...ConsentCommandNameSchema.options].sort(),
    )
  })

  it('maps every alias in the whole allowlist to exactly one command', () => {
    const owners = new Map<string, string>()
    for (const [name, entry] of Object.entries(ALLOWLISTED_COMMAND_ALIASES)) {
      for (const alias of [...entry.ja, ...entry.icons, ...entry.en]) {
        expect(owners.get(alias), `${alias} is ambiguous`).toBeUndefined()
        owners.set(alias, name)
      }
    }
  })

  it('does not reuse a T14 call-to-action string for a consent command', () => {
    // The screen invites the three care commands (TASK_SPECS §T14); typing one
    // of those must never be a consent decision.
    const cta = [
      ...COMMAND_ALIASES.FEED.ja,
      ...COMMAND_ALIASES.FEED.icons,
      ...COMMAND_ALIASES.PLAY.ja,
      ...COMMAND_ALIASES.PLAY.icons,
      ...COMMAND_ALIASES.PET.ja,
      ...COMMAND_ALIASES.PET.icons,
    ]
    const consent = Object.values(CONSENT_COMMAND_ALIASES).flatMap((entry) => [
      ...entry.ja,
      ...entry.icons,
      ...entry.en,
    ])
    expect(consent.filter((alias) => cta.includes(alias))).toEqual([])
  })
})

describe('ConsentCommandRef', () => {
  it('accepts a consent command with no argument', () => {
    expect(ConsentCommandRefSchema.parse({ name: 'JOIN', argument: null })).toEqual({
      name: 'JOIN',
      argument: null,
    })
    expect(ConsentCommandRefSchema.safeParse({ name: 'LEAVE', argument: null }).success).toBe(true)
  })

  it('refuses an argument, so nothing can ride along with a consent decision', () => {
    expect(ConsentCommandRefSchema.safeParse({ name: 'JOIN', argument: 'now' }).success).toBe(false)
  })

  it('refuses a world command', () => {
    expect(ConsentCommandRefSchema.safeParse({ name: 'FEED', argument: null }).success).toBe(false)
  })
})

describe('AnyCommandRef', () => {
  it('accepts either half of the allowlist', () => {
    expect(AnyCommandRefSchema.safeParse({ name: 'FEED', argument: null }).success).toBe(true)
    expect(AnyCommandRefSchema.safeParse({ name: 'JOIN', argument: null }).success).toBe(true)
  })

  it('narrows a parser result to the half that owns it', () => {
    expect(isConsentCommandRef({ name: 'JOIN', argument: null })).toBe(true)
    expect(isConsentCommandRef({ name: 'LEAVE', argument: null })).toBe(true)
    expect(isConsentCommandRef({ name: 'FEED', argument: null })).toBe(false)
    expect(isConsentCommandRef({ name: 'VOTE_A', argument: 'choice_a' })).toBe(false)
  })
})
