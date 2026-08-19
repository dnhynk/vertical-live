import { describe, expect, it } from 'vitest'

import { parseMessage, type ParserLimits } from './parse.js'
import type { ParseContext } from './types.js'

const LIMITS: ParserLimits = { maxRawLength: 500 }

/** BOARD A-1: the identity gate is closed in V1, so this is the live setting. */
const GATE_CLOSED: ParseContext = { identityGateOpen: false, voteWindowOpen: false }
const GATE_OPEN_WINDOW_OPEN: ParseContext = { identityGateOpen: true, voteWindowOpen: true }
const GATE_OPEN_WINDOW_CLOSED: ParseContext = { identityGateOpen: true, voteWindowOpen: false }
const GATE_CLOSED_WINDOW_OPEN: ParseContext = { identityGateOpen: false, voteWindowOpen: true }

const parse = (text: string, context: ParseContext = GATE_CLOSED) =>
  parseMessage(text, context, LIMITS)

describe('accepted commands', () => {
  it('accepts a bare command with a null argument', () => {
    expect(parse('feed')).toEqual({
      status: 'accepted',
      command: { name: 'FEED', argument: null },
      commandLike: true,
    })
  })

  it('accepts one short word as an argument', () => {
    expect(parse('play round2')).toEqual({
      status: 'accepted',
      command: { name: 'PLAY', argument: 'round2' },
      commandLike: true,
    })
  })
})

describe('vote gating (spec §6.4, §7.1, BOARD A-1/A-9)', () => {
  it.each(['a', 'b', 'c'])('rejects %s while the identity gate is closed', (text) => {
    expect(parse(text, GATE_CLOSED)).toEqual({
      status: 'rejected',
      reason: 'vote_disabled',
      commandLike: true,
    })
  })

  it('rejects a vote when the gate is open but no window is', () => {
    expect(parse('a', GATE_OPEN_WINDOW_CLOSED).status).toBe('rejected')
    expect(parse('a', GATE_OPEN_WINDOW_CLOSED)).toMatchObject({ reason: 'vote_disabled' })
  })

  it('rejects a vote when a window is open but the gate is not', () => {
    expect(parse('a', GATE_CLOSED_WINDOW_OPEN)).toMatchObject({ reason: 'vote_disabled' })
  })

  it('accepts A/B/C only when both are open', () => {
    expect(parse('a', GATE_OPEN_WINDOW_OPEN)).toMatchObject({
      status: 'accepted',
      command: { name: 'VOTE_A', argument: null },
    })
    expect(parse('VOTE_B', GATE_OPEN_WINDOW_OPEN)).toMatchObject({
      command: { name: 'VOTE_B' },
    })
  })

  it('counts a blocked vote as command-like for the success metric', () => {
    const result = parse('a', GATE_CLOSED)
    expect(result.commandLike).toBe(true)
  })
})

describe('shape rules', () => {
  it('rejects a command followed by free text', () => {
    expect(parse('feed the creature now please')).toMatchObject({
      reason: 'extraneous_text',
      commandLike: true,
    })
  })

  it('rejects two commands in one message', () => {
    expect(parse('feed play')).toMatchObject({ reason: 'extraneous_text' })
  })

  it('rejects an argument outside the contract token charset', () => {
    expect(parse('ごはん りんご')).toMatchObject({ reason: 'invalid_argument' })
    expect(parse(`feed ${'a'.repeat(33)}`)).toMatchObject({ reason: 'invalid_argument' })
  })

  it('rejects a separator inside an argument (R-T6-1 blocker 1)', () => {
    // The contract charset allows `-` and `_`; the parser does not, because a
    // separator is how a host or an address gets spelled as one token.
    expect(parse('play tag-game')).toMatchObject({ reason: 'invalid_argument' })
    expect(parse('play snack_time')).toMatchObject({ reason: 'invalid_argument' })
  })

  it('rejects a message that is not a command at all', () => {
    expect(parse('こんばんは')).toEqual({
      status: 'rejected',
      reason: 'no_command',
      commandLike: false,
    })
  })
})

describe('guards', () => {
  it('rejects an over-length message without normalizing it', () => {
    expect(parse('a'.repeat(501))).toEqual({
      status: 'rejected',
      reason: 'too_long',
      commandLike: false,
    })
  })

  it('rejects a message that normalizes to nothing', () => {
    expect(parse('​‍­⠀')).toMatchObject({ reason: 'empty' })
  })

  it('rejects an empty message', () => {
    expect(parse('')).toMatchObject({ reason: 'empty' })
  })
})

describe('moderation outranks the shape rules (spec §12.3)', () => {
  it('reports the moderation code even when the shape is also wrong', () => {
    // The message is both a link and free text after a command; §12.3 discards
    // this class "regardless of any command effect", so the link wins.
    expect(parse('feed https://example.invalid/spam now')).toMatchObject({ reason: 'url' })
  })

  it('rejects a well-shaped command whose argument is a banned term', () => {
    expect(parse('feed p0rn')).toMatchObject({ reason: 'banned_sexual', commandLike: true })
  })
})

describe('purity', () => {
  it('returns the same result for the same input', () => {
    const a = parse('ごはん')
    const b = parse('ごはん')
    expect(a).toEqual(b)
  })

  it('depends on the context, not on call history', () => {
    expect(parse('a', GATE_OPEN_WINDOW_OPEN).status).toBe('accepted')
    expect(parse('a', GATE_CLOSED).status).toBe('rejected')
    expect(parse('a', GATE_OPEN_WINDOW_OPEN).status).toBe('accepted')
  })
})

/**
 * Consent commands (BOARD D-9, TASK_SPECS §T20a/§T20b).
 *
 * They are allowlisted commands of spec §7.1, but they move no world state, so
 * the parser returns them under their own status. Nothing that switches on
 * `status === 'accepted'` can therefore see a `JOIN`.
 */
describe('consent commands', () => {
  it('accepts なのる / なまえけす and their English aliases while the gate is open', () => {
    for (const [text, name] of [
      ['なのる', 'JOIN'],
      ['JOIN', 'JOIN'],
      ['join', 'JOIN'],
      ['なまえけす', 'LEAVE'],
      ['LEAVE', 'LEAVE'],
    ] as const) {
      expect(parse(text, GATE_OPEN_WINDOW_CLOSED)).toEqual({
        status: 'accepted_consent',
        consentCommand: { name, argument: null },
        commandLike: true,
      })
    }
  })

  it('refuses them while the consent gate is closed', () => {
    // Accepting a `JOIN` the closed configuration would not store is a consent
    // the system did not honour (BOARD A-1, D-9).
    for (const text of ['なのる', 'JOIN', 'なまえけす', 'LEAVE']) {
      expect(parse(text, GATE_CLOSED)).toEqual({
        status: 'rejected',
        reason: 'consent_disabled',
        commandLike: true,
      })
    }
  })

  it('takes no argument at all', () => {
    // `ConsentCommandRefSchema.argument` is `null` by construction: an argument
    // slot would be a second place a chat line could ride along.
    expect(parse('join now', GATE_OPEN_WINDOW_CLOSED)).toMatchObject({
      reason: 'extraneous_text',
      commandLike: true,
    })
    expect(parse('なのる ごはん', GATE_OPEN_WINDOW_CLOSED)).toMatchObject({
      reason: 'extraneous_text',
    })
  })

  it('never returns a consent command as a world command', () => {
    const result = parse('なのる', GATE_OPEN_WINDOW_OPEN)
    expect(result.status).not.toBe('accepted')
    expect(result).not.toHaveProperty('command')
  })

  it('keeps the moderation order: a link outranks the consent shape', () => {
    expect(parse('join https://example.invalid/spam', GATE_OPEN_WINDOW_CLOSED)).toMatchObject({
      reason: 'url',
    })
  })
})
