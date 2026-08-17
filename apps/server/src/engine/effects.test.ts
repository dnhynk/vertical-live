import { EffectSchema } from '@vl/contract'
import { describe, expect, it } from 'vitest'

import type { EffectDraft } from '../world/types.js'
import { assembleEffect, assembleEffects } from './effects.js'
import { deadlineRowIdFor, effectIdFor } from './ids.js'

/**
 * Effect assembly (BOARD A-17). The reducer decides *what* and *why*; the engine
 * decides *which revision*, *which id* and *which persisted deadline row* — and
 * the two cause rules must survive that split.
 */

const eventDraft: EffectDraft = {
  kind: 'ACTION_REACTION',
  paid: false,
  cause: { kind: 'event', eventKey: 'simulator:brd_test:msg_test_0001' },
  variantId: 'reaction_test',
  startsAt: '2026-08-16T00:00:00.000Z',
  endsAt: '2026-08-16T00:00:04.000Z',
  payload: { commandName: 'FEED', contributionCount: 2 },
}

const deadlineDraft: EffectDraft = {
  kind: 'AMBIENCE',
  paid: false,
  cause: { kind: 'deadline', deadlineKind: 'idle_beat' },
  variantId: 'ambience_test',
  startsAt: '2026-08-16T00:00:00.000Z',
  endsAt: '2026-08-16T00:00:06.000Z',
  payload: { ambienceId: 'ambience_test' },
}

const paidDraft: EffectDraft = {
  kind: 'PAID_THANKS',
  paid: true,
  cause: { kind: 'event', eventKey: 'simulator:brd_test:msg_test_0002' },
  variantId: 'thanks_super_chat',
  startsAt: '2026-08-16T00:00:00.000Z',
  endsAt: '2026-08-16T00:00:08.000Z',
  payload: { paidEventKind: 'SUPER_CHAT', iconId: 'thanks_super_chat', tier: 1, fallback: false },
}

describe('assembleEffect', () => {
  it('restates the event key on an event-caused effect', () => {
    const effect = assembleEffect(eventDraft, { revision: 7 }, 0)

    expect(effect.effectId).toBe('e7_0')
    expect(effect.stateRevision).toBe(7)
    expect(effect.cause).toEqual({ kind: 'event', eventKey: 'simulator:brd_test:msg_test_0001' })
    expect(effect.causedByEventKey).toBe('simulator:brd_test:msg_test_0001')
    expect(() => EffectSchema.parse(effect)).not.toThrow()
  })

  it('leaves causedByEventKey null on a timer-caused effect (spec §2.1)', () => {
    const effect = assembleEffect(deadlineDraft, { revision: 3 }, 1)

    expect(effect.causedByEventKey).toBeNull()
    expect(effect.cause).toEqual({ kind: 'deadline', deadlineKind: 'idle_beat' })
  })

  it('names the deadline row only when that kind is the one being delivered', () => {
    const matching = assembleEffect(
      deadlineDraft,
      { revision: 3, deadline: { kind: 'idle_beat', rowId: 'idle_beat' } },
      0,
    )
    const other = assembleEffect(
      deadlineDraft,
      { revision: 3, deadline: { kind: 'chapter_beat', rowId: 'chapter_beat_abc' } },
      0,
    )

    expect(matching.cause).toEqual({
      kind: 'deadline',
      deadlineKind: 'idle_beat',
      deadlineId: 'idle_beat',
    })
    // No guessing: a row id the engine cannot vouch for is simply absent.
    expect(other.cause).toEqual({ kind: 'deadline', deadlineKind: 'idle_beat' })
  })

  it('assembles a batch with unique ids in order', () => {
    const effects = assembleEffects([eventDraft, deadlineDraft, paidDraft], { revision: 11 })

    expect(effects.map((effect) => effect.effectId)).toEqual(['e11_0', 'e11_1', 'e11_2'])
    expect(effects[2]?.paid).toBe(true)
    expect(effects[2]?.causedByEventKey).toBe('simulator:brd_test:msg_test_0002')
  })
})

describe('id issuance', () => {
  it('derives an effect id from the revision and the position', () => {
    expect(effectIdFor(0, 0)).toBe('e0_0')
    expect(effectIdFor(1234, 9)).toBe('e1234_9')
    expect(() => effectIdFor(-1, 0)).toThrow(RangeError)
    expect(() => effectIdFor(1, -1)).toThrow(RangeError)
  })

  it('keeps a deadline row id inside the contract charset for any key', () => {
    expect(deadlineRowIdFor('idle_beat', null)).toBe('idle_beat')
    const withKey = deadlineRowIdFor('paid_thanks_fallback', 'simulator:brd_test:msg_test_0002')
    expect(withKey).toMatch(/^paid_thanks_fallback_[0-9a-f]{16}$/)
    // The colon of an event key can never appear in a deadline id.
    expect(withKey).not.toContain(':')
    expect(deadlineRowIdFor('paid_thanks_fallback', 'a'.repeat(500))).toHaveLength(
      'paid_thanks_fallback'.length + 17,
    )
  })

  it('gives different keys different rows', () => {
    expect(deadlineRowIdFor('chapter_beat', 'setup')).not.toBe(
      deadlineRowIdFor('chapter_beat', 'turn'),
    )
  })
})
