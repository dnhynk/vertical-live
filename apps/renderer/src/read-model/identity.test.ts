import { describe, expect, it } from 'vitest'
import { DISPLAY_NAME_MAX_LENGTH, type Effect, type WorldSnapshot } from '@vl/contract'

import {
  SAMPLE_CONSENTED_ACTOR,
  sampleActionEffect,
  sampleDeadlineEffect,
  samplePaidThanksEffect,
  sampleSnapshot,
} from '../testing/fixtures'
import {
  DISPLAY_NAME_SCREEN_MAX_GRAPHEMES,
  sanitizeDisplayName,
  selectActionActorName,
} from './identity'

/**
 * TASK_SPECS §T20c: the name of a consented viewer, only of a consented viewer,
 * and only on the action that viewer actually took (BOARD D-9, spec §5.2(2),
 * §12.3).
 *
 * The negative cases carry the weight here. A missing name costs the screen a
 * flourish; a name on the wrong action is a false claim about who participated
 * (spec §2.6), and a name shown while the gate is closed is stored-and-shown
 * identity nobody agreed to (BOARD A-1).
 *
 * Every invisible character below is written as an escape. A test about
 * characters you cannot see has to be readable in the diff that reviews it.
 */

const APPLIED_AT = '2026-08-17T00:00:30.000Z'

function action(overrides: Record<string, unknown> = {}): Effect {
  return sampleActionEffect({
    startsAt: APPLIED_AT,
    endsAt: '2026-08-17T00:00:34.000Z',
    payload: { commandName: 'FEED', contributionCount: 1 },
    ...overrides,
  })
}

function snapshotWith(display: Partial<WorldSnapshot['display']> = {}): WorldSnapshot {
  const base = sampleSnapshot()
  return sampleSnapshot({
    display: {
      ...base.display,
      lastAppliedAction: { commandName: 'FEED', appliedAt: APPLIED_AT, contributionCount: 1 },
      ...display,
    },
  })
}

function graphemeCount(value: string): number {
  return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(value)].length
}

describe('sanitizeDisplayName (spec §12.3)', () => {
  it('passes an ordinary name through unchanged', () => {
    expect(sanitizeDisplayName('sample-viewer-1')).toBe('sample-viewer-1')
  })

  it('keeps an emoji sequence whole, joiner and all', () => {
    // One grapheme cluster held together by the zero-width joiner the contract
    // deliberately lets through `DisplayNameSchema`.
    const name = 'v\u{1f469}\u200d\u{1f680}'
    expect(sanitizeDisplayName(name)).toBe(name)
  })

  it('removes bidirectional controls, which could reorder the slot around the name', () => {
    expect(sanitizeDisplayName('a\u202eb\u202cc')).toBe('abc')
    expect(sanitizeDisplayName('\u2066a\u2069')).toBe('a')
    expect(sanitizeDisplayName('\u200ea\u200f')).toBe('a')
    expect(sanitizeDisplayName('\u061ca')).toBe('a')
  })

  it('removes control characters and invisible formatting', () => {
    expect(sanitizeDisplayName('a\u0000b')).toBe('ab')
    expect(sanitizeDisplayName('a\u0007b')).toBe('ab')
    expect(sanitizeDisplayName('a\u00adb')).toBe('ab')
    expect(sanitizeDisplayName('a\ufeffb')).toBe('ab')
  })

  it('folds a name onto one line', () => {
    expect(sanitizeDisplayName('  a \t\n b  ')).toBe('a b')
    expect(sanitizeDisplayName('a\u00a0b')).toBe('a b')
    expect(sanitizeDisplayName('a  b')).toBe('a b')
  })

  it('has nothing to show for a name that was only invisible characters', () => {
    expect(sanitizeDisplayName('')).toBeNull()
    expect(sanitizeDisplayName('   ')).toBeNull()
    expect(sanitizeDisplayName('\u202a\u202c')).toBeNull()
  })

  it('shortens a long name instead of letting it take the slot', () => {
    const long = 'a'.repeat(DISPLAY_NAME_SCREEN_MAX_GRAPHEMES + 10)
    expect(sanitizeDisplayName(long)).toBe('a'.repeat(DISPLAY_NAME_SCREEN_MAX_GRAPHEMES) + '…')
  })

  it('cuts on grapheme clusters, so an emoji is never split in half', () => {
    const pair = '\u{1f1ef}\u{1f1f5}'
    const shortened = sanitizeDisplayName(pair.repeat(DISPLAY_NAME_SCREEN_MAX_GRAPHEMES + 4)) ?? ''
    // Every regional-indicator pair survived as a pair: no lone indicator left
    // over, and exactly the bound plus the ellipsis.
    expect(graphemeCount(shortened)).toBe(DISPLAY_NAME_SCREEN_MAX_GRAPHEMES + 1)
    expect(shortened).toBe(pair.repeat(DISPLAY_NAME_SCREEN_MAX_GRAPHEMES) + '…')
  })

  it('refuses a value longer than the contract can carry', () => {
    expect(sanitizeDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH))).not.toBeNull()
    expect(sanitizeDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBeNull()
  })

  it('returns text, never markup', () => {
    // The module neither strips nor interprets HTML — it has no reason to. The
    // slot renders the result as a React text node, so a `<` stays a `<` on
    // screen and never becomes an element (spec §12.3).
    const raw = '<img src=x onerror=alert(1)>'
    expect(sanitizeDisplayName(raw)).toBe(raw.slice(0, DISPLAY_NAME_SCREEN_MAX_GRAPHEMES) + '…')
  })
})

describe('selectActionActorName (BOARD D-9, spec §5.2(2))', () => {
  it('names the consented viewer whose action the slot is showing', () => {
    const effects = [action({ actor: SAMPLE_CONSENTED_ACTOR })]
    expect(selectActionActorName(snapshotWith(), effects)).toBe(SAMPLE_CONSENTED_ACTOR.displayName)
  })

  it('shows no name while the gate is closed, whatever else is on screen', () => {
    // The closed-mode wire shape: no `actor` on anything (BOARD A-1, T20a).
    const effects = [action(), samplePaidThanksEffect(), sampleDeadlineEffect()]
    expect(selectActionActorName(snapshotWith(), effects)).toBeNull()
  })

  it('shows no name for a viewer who has not opted in', () => {
    expect(selectActionActorName(snapshotWith(), [action({ actor: null })])).toBeNull()
  })

  it('shows no name before the first snapshot or before the first action', () => {
    expect(selectActionActorName(null, [action({ actor: SAMPLE_CONSENTED_ACTOR })])).toBeNull()
    const empty = snapshotWith({ lastAppliedAction: null })
    expect(selectActionActorName(empty, [action({ actor: SAMPLE_CONSENTED_ACTOR })])).toBeNull()
  })

  it('shows no name when no reaction is playing', () => {
    // `activeEffects` is the read model's window on what is on screen, so an
    // expired reaction is simply not here — and the name goes with it. The
    // renderer keeps no copy (BOARD D-9, "delete immediately").
    expect(selectActionActorName(snapshotWith(), [])).toBeNull()
    expect(selectActionActorName(snapshotWith(), [sampleDeadlineEffect()])).toBeNull()
  })

  it('does not lend an older viewer name to a newer action', () => {
    // The misattribution that matters: a consented viewer fed the creature, then
    // somebody anonymous fed it again while the first reaction was still
    // playing. The slot describes the second action now, so it stays anonymous.
    const older = action({
      effectId: 'sample-effect-action-older',
      actor: SAMPLE_CONSENTED_ACTOR,
      startsAt: '2026-08-17T00:00:29.000Z',
      endsAt: '2026-08-17T00:00:33.000Z',
    })
    const newer = action({ effectId: 'sample-effect-action-newer' })
    expect(selectActionActorName(snapshotWith(), [older, newer])).toBeNull()
    // and the order of arrival changes nothing.
    expect(selectActionActorName(snapshotWith(), [newer, older])).toBeNull()
  })

  it('refuses to choose between two reactions staged in the same millisecond', () => {
    const named = action({ effectId: 'sample-effect-action-a', actor: SAMPLE_CONSENTED_ACTOR })
    const other = action({ effectId: 'sample-effect-action-b' })
    expect(selectActionActorName(snapshotWith(), [named, other])).toBeNull()
  })

  it('shows no name when the playing reaction is not the action in the slot', () => {
    const otherCommand = action({
      actor: SAMPLE_CONSENTED_ACTOR,
      payload: { commandName: 'PET', contributionCount: 1 },
    })
    expect(selectActionActorName(snapshotWith(), [otherCommand])).toBeNull()

    // Same command, different count: the slot is showing an aggregated FEED and
    // the playing reaction is one viewer's single FEED. The contract forbids the
    // mirror image of this (a named reaction with a count above one), so the
    // mismatch can only be spelled from the snapshot's side.
    const aggregated = snapshotWith({
      lastAppliedAction: { commandName: 'FEED', appliedAt: APPLIED_AT, contributionCount: 2 },
    })
    expect(
      selectActionActorName(aggregated, [action({ actor: SAMPLE_CONSENTED_ACTOR })]),
    ).toBeNull()
  })

  it('shows no name when the reaction is newer than the snapshot it would name', () => {
    const ahead = action({
      actor: SAMPLE_CONSENTED_ACTOR,
      startsAt: '2026-08-17T00:00:31.000Z',
      endsAt: '2026-08-17T00:00:35.000Z',
    })
    expect(selectActionActorName(snapshotWith(), [ahead])).toBeNull()
  })

  it('compares instants, not strings', () => {
    // `IsoUtcInstantSchema` accepts both spellings of the same moment, and they
    // do not sort the way they read.
    const named = action({ actor: SAMPLE_CONSENTED_ACTOR, startsAt: '2026-08-17T00:00:30Z' })
    expect(selectActionActorName(snapshotWith(), [named])).toBe(SAMPLE_CONSENTED_ACTOR.displayName)
  })

  it('never names an aggregated reaction, because it stands for many viewers', () => {
    // The contract refuses the combination outright (spec §6.4, §7.3), so the
    // screen has no shape to arrive at one from.
    expect(() =>
      sampleActionEffect({
        actor: SAMPLE_CONSENTED_ACTOR,
        payload: { commandName: 'FEED', contributionCount: 7 },
      }),
    ).toThrow()
  })

  it('shows a shortened name rather than a wide one', () => {
    const long = action({
      actor: { ...SAMPLE_CONSENTED_ACTOR, displayName: 'sample-viewer-with-a-very-long-name' },
    })
    const shown = selectActionActorName(snapshotWith(), [long]) ?? ''
    expect(graphemeCount(shown)).toBe(DISPLAY_NAME_SCREEN_MAX_GRAPHEMES + 1)
  })
})
