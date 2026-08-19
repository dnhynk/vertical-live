import { describe, expect, it } from 'vitest'
import {
  DISPLAY_NAME_MAX_LENGTH,
  DisplayNameSchema,
  type Effect,
  type WorldSnapshot,
} from '@vl/contract'

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
  trackActionRevision,
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

/**
 * The revision the fixtures commit the slot's action at. Both `sampleSnapshot`
 * and `sampleActionEffect` carry `stateRevision: 1`, which is what a snapshot
 * and the effects of one commit look like on the wire.
 */
const ACTION_REVISION = 1

function snapshotWith(
  display: Partial<WorldSnapshot['display']> = {},
  stateRevision = ACTION_REVISION,
): WorldSnapshot {
  const base = sampleSnapshot()
  return sampleSnapshot({
    stateRevision,
    display: {
      ...base.display,
      lastAppliedAction: { commandName: 'FEED', appliedAt: APPLIED_AT, contributionCount: 1 },
      ...display,
    },
  })
}

/** The revision the slot's action was committed at, after this run of snapshots. */
function revisionAfter(...snapshots: readonly WorldSnapshot[]): number | null {
  let previous: WorldSnapshot | null = null
  let carried: number | null = null
  for (const snapshot of snapshots) {
    carried = trackActionRevision(previous, snapshot, carried)
    previous = snapshot
  }
  return carried
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

  it('measures that bound in code points, the unit the contract measures it in', () => {
    // An astral character is two UTF-16 code units and one code point, and
    // `DisplayNameSchema`'s quantifier runs under the `u` flag, so it counts
    // code points. A name of 60 emoji is 120 code units: the contract accepts it
    // and the screen must shorten it, not refuse it.
    const emoji = '\u{1f600}'
    const sixty = emoji.repeat(60)
    expect(sixty.length).toBe(120)
    expect([...sixty].length).toBe(60)
    expect(DisplayNameSchema.safeParse(sixty).success).toBe(true)
    expect(sanitizeDisplayName(sixty)).toBe(emoji.repeat(DISPLAY_NAME_SCREEN_MAX_GRAPHEMES) + '…')

    // And the bound itself is still a bound, drawn on the same boundary the
    // contract draws it on.
    const atBound = emoji.repeat(DISPLAY_NAME_MAX_LENGTH)
    const overBound = emoji.repeat(DISPLAY_NAME_MAX_LENGTH + 1)
    expect(DisplayNameSchema.safeParse(atBound).success).toBe(true)
    expect(DisplayNameSchema.safeParse(overBound).success).toBe(false)
    expect(sanitizeDisplayName(atBound)).not.toBeNull()
    expect(sanitizeDisplayName(overBound)).toBeNull()
  })

  it('returns text, never markup', () => {
    // The module neither strips nor interprets HTML — it has no reason to. The
    // slot renders the result as a React text node, so a `<` stays a `<` on
    // screen and never becomes an element (spec §12.3).
    const raw = '<img src=x onerror=alert(1)>'
    expect(sanitizeDisplayName(raw)).toBe(raw.slice(0, DISPLAY_NAME_SCREEN_MAX_GRAPHEMES) + '…')
  })
})

describe('trackActionRevision (the causal key of the join)', () => {
  it('remembers the revision the action first appeared at, not the newest one', () => {
    const applied = snapshotWith({}, 7)
    // Two later commits that changed something else entirely: the slot still
    // shows the same action, so the join must still point at commit 7.
    const later = snapshotWith({}, 8)
    const latest = snapshotWith({}, 9)
    expect(revisionAfter(applied, later, latest)).toBe(7)
  })

  it('moves to the new commit when the action changes', () => {
    const first = snapshotWith({}, 7)
    const second = snapshotWith(
      { lastAppliedAction: { commandName: 'PET', appliedAt: APPLIED_AT, contributionCount: 1 } },
      8,
    )
    expect(revisionAfter(first, second)).toBe(8)
  })

  it('compares instants, not strings', () => {
    // `IsoUtcInstantSchema` accepts both spellings of the same moment. Reading
    // one as a new action would move the key onto a commit that staged nothing.
    const first = snapshotWith({}, 7)
    const respelled = snapshotWith(
      {
        lastAppliedAction: {
          commandName: 'FEED',
          appliedAt: '2026-08-17T00:00:30Z',
          contributionCount: 1,
        },
      },
      8,
    )
    expect(revisionAfter(first, respelled)).toBe(7)
  })

  it('takes the first snapshot at its word, and an empty slot clears the key', () => {
    // On load and after every reconnect there is no previous snapshot to compare
    // against. The revision of that snapshot is used, which can only ever be
    // matched by an effect from that same commit — see the selector's tests.
    expect(revisionAfter(snapshotWith({}, 7))).toBe(7)
    expect(revisionAfter(snapshotWith({ lastAppliedAction: null }, 7))).toBeNull()
    expect(
      revisionAfter(snapshotWith({}, 7), snapshotWith({ lastAppliedAction: null }, 8)),
    ).toBeNull()
  })
})

describe('selectActionActorName (BOARD D-9, spec §5.2(2))', () => {
  it('names the consented viewer whose action the slot is showing', () => {
    const effects = [action({ actor: SAMPLE_CONSENTED_ACTOR })]
    expect(selectActionActorName(snapshotWith(), effects, ACTION_REVISION)).toBe(
      SAMPLE_CONSENTED_ACTOR.displayName,
    )
  })

  it('shows no name while the gate is closed, whatever else is on screen', () => {
    // The closed-mode wire shape: no `actor` on anything (BOARD A-1, T20a).
    const effects = [action(), samplePaidThanksEffect(), sampleDeadlineEffect()]
    expect(selectActionActorName(snapshotWith(), effects, ACTION_REVISION)).toBeNull()
  })

  it('shows no name for a viewer who has not opted in', () => {
    expect(
      selectActionActorName(snapshotWith(), [action({ actor: null })], ACTION_REVISION),
    ).toBeNull()
  })

  it('shows no name before the first snapshot or before the first action', () => {
    const named = [action({ actor: SAMPLE_CONSENTED_ACTOR })]
    expect(selectActionActorName(null, named, null)).toBeNull()
    const empty = snapshotWith({ lastAppliedAction: null })
    expect(selectActionActorName(empty, named, revisionAfter(empty))).toBeNull()
  })

  it('shows no name when no reaction is playing', () => {
    // `activeEffects` is the read model's window on what is on screen, so an
    // expired reaction is simply not here — and the name goes with it. The
    // renderer keeps no copy (BOARD D-9, "delete immediately").
    expect(selectActionActorName(snapshotWith(), [], ACTION_REVISION)).toBeNull()
    expect(
      selectActionActorName(snapshotWith(), [sampleDeadlineEffect()], ACTION_REVISION),
    ).toBeNull()
  })

  it('does not lend a viewer name to the next action whose snapshot arrives first', () => {
    // The review's counterexample, and the reason the join is keyed on the
    // commit. Viewer A's named FEED/1 was committed at revision 10 and is still
    // playing. Viewer B feeds too; the server publishes B's snapshot *before*
    // B's effect (`apps/server/src/engine/engine.ts`), so for a moment the slot
    // describes B's action while only A's reaction is on screen. Command, count
    // and staging time all match — only the revision does not.
    const applied = snapshotWith({}, 10)
    const byViewerA = action({
      effectId: 'sample-effect-action-a',
      actor: SAMPLE_CONSENTED_ACTOR,
      stateRevision: 10,
    })
    expect(selectActionActorName(applied, [byViewerA], revisionAfter(applied))).toBe(
      SAMPLE_CONSENTED_ACTOR.displayName,
    )

    const nextAction = snapshotWith(
      {
        lastAppliedAction: {
          commandName: 'FEED',
          appliedAt: '2026-08-17T00:00:32.000Z',
          contributionCount: 1,
        },
      },
      11,
    )
    const key = revisionAfter(applied, nextAction)
    expect(key).toBe(11)
    expect(selectActionActorName(nextAction, [byViewerA], key)).toBeNull()

    // B's own reaction lands a moment later. A's is still playing; B never opted
    // in, so the slot stays anonymous rather than falling back to the name it
    // can still see.
    const byViewerB = action({
      effectId: 'sample-effect-action-b',
      stateRevision: 11,
      startsAt: '2026-08-17T00:00:32.000Z',
      endsAt: '2026-08-17T00:00:36.000Z',
    })
    expect(selectActionActorName(nextAction, [byViewerA, byViewerB], key)).toBeNull()
  })

  it('survives a retransmitted reaction, which is one effect twice', () => {
    // Spec §7.3(7): the server resends an effect it holds no ACK for. The read
    // model is keyed by `effectId`, so a resend never reaches the selector as a
    // second effect and the name stays where it is. Handed two copies anyway,
    // the "exactly one candidate" rule refuses rather than picks — it loses a
    // name, which is the direction this module is allowed to be wrong in.
    const named = action({ actor: SAMPLE_CONSENTED_ACTOR })
    expect(selectActionActorName(snapshotWith(), [named], ACTION_REVISION)).toBe(
      SAMPLE_CONSENTED_ACTOR.displayName,
    )
    expect(selectActionActorName(snapshotWith(), [named, named], ACTION_REVISION)).toBeNull()
  })

  it('follows two named actions in a row, one commit at a time', () => {
    const first = snapshotWith({}, 10)
    const byViewerA = action({
      effectId: 'sample-effect-action-a',
      actor: SAMPLE_CONSENTED_ACTOR,
      stateRevision: 10,
    })
    const second = snapshotWith(
      {
        lastAppliedAction: {
          commandName: 'FEED',
          appliedAt: '2026-08-17T00:00:32.000Z',
          contributionCount: 1,
        },
      },
      11,
    )
    const byViewerB = action({
      effectId: 'sample-effect-action-b',
      actor: { ...SAMPLE_CONSENTED_ACTOR, displayName: 'sample-viewer-2' },
      stateRevision: 11,
      startsAt: '2026-08-17T00:00:32.000Z',
      endsAt: '2026-08-17T00:00:36.000Z',
    })

    // Both reactions play at once; the slot names the one whose commit it is
    // describing, and the other name is never on screen.
    expect(selectActionActorName(first, [byViewerA], revisionAfter(first))).toBe('sample-viewer-1')
    expect(
      selectActionActorName(second, [byViewerA, byViewerB], revisionAfter(first, second)),
    ).toBe('sample-viewer-2')
  })

  it('refuses to choose between two reactions from the same commit', () => {
    // A commit that applied the same command twice is a commit whose reactions
    // this module cannot tell apart. Naming either viewer would be a guess.
    const named = action({ effectId: 'sample-effect-action-a', actor: SAMPLE_CONSENTED_ACTOR })
    const other = action({ effectId: 'sample-effect-action-b' })
    expect(selectActionActorName(snapshotWith(), [named, other], ACTION_REVISION)).toBeNull()
    expect(selectActionActorName(snapshotWith(), [other, named], ACTION_REVISION)).toBeNull()
  })

  it('shows no name for a reaction that arrives before the snapshot it belongs to', () => {
    // The other order spec §7.3(6) allows: the effect is on screen while the
    // snapshot that moves the slot onto it is still in flight. Until that
    // snapshot lands the key still points at the previous commit, so the slot is
    // anonymous — and the name appears when the two messages agree, not before.
    const applied = snapshotWith({}, 10)
    const ahead = action({
      actor: SAMPLE_CONSENTED_ACTOR,
      stateRevision: 11,
      startsAt: '2026-08-17T00:00:32.000Z',
      endsAt: '2026-08-17T00:00:36.000Z',
    })
    expect(selectActionActorName(applied, [ahead], revisionAfter(applied))).toBeNull()

    const nextAction = snapshotWith(
      {
        lastAppliedAction: {
          commandName: 'FEED',
          appliedAt: '2026-08-17T00:00:32.000Z',
          contributionCount: 1,
        },
      },
      11,
    )
    expect(selectActionActorName(nextAction, [ahead], revisionAfter(applied, nextAction))).toBe(
      SAMPLE_CONSENTED_ACTOR.displayName,
    )
  })

  it('shows no name when a revision was skipped, rather than guessing at it', () => {
    // Spec §10.2 lets snapshots coalesce, and `ReadModel` drops a stale one. The
    // change is then noticed at a revision later than the one it happened at, so
    // the reaction no longer matches: anonymous, never somebody else's name.
    const before = snapshotWith(
      { lastAppliedAction: { commandName: 'PET', appliedAt: APPLIED_AT, contributionCount: 1 } },
      10,
    )
    const afterSkip = snapshotWith({}, 20)
    const key = revisionAfter(before, afterSkip)
    expect(key).toBe(20)
    expect(
      selectActionActorName(
        afterSkip,
        [action({ actor: SAMPLE_CONSENTED_ACTOR, stateRevision: 15 })],
        key,
      ),
    ).toBeNull()
  })

  it('shows no name when the playing reaction is not the action in the slot', () => {
    const otherCommand = action({
      actor: SAMPLE_CONSENTED_ACTOR,
      payload: { commandName: 'PET', contributionCount: 1 },
    })
    expect(selectActionActorName(snapshotWith(), [otherCommand], ACTION_REVISION)).toBeNull()

    // Same command, different count: the slot is showing an aggregated FEED and
    // the playing reaction is one viewer's single FEED. The contract forbids the
    // mirror image of this (a named reaction with a count above one), so the
    // mismatch can only be spelled from the snapshot's side.
    const aggregated = snapshotWith({
      lastAppliedAction: { commandName: 'FEED', appliedAt: APPLIED_AT, contributionCount: 2 },
    })
    expect(
      selectActionActorName(
        aggregated,
        [action({ actor: SAMPLE_CONSENTED_ACTOR })],
        ACTION_REVISION,
      ),
    ).toBeNull()
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
    const shown = selectActionActorName(snapshotWith(), [long], ACTION_REVISION) ?? ''
    expect(graphemeCount(shown)).toBe(DISPLAY_NAME_SCREEN_MAX_GRAPHEMES + 1)
  })
})
