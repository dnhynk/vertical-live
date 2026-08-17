import { describe, expect, it } from 'vitest'

import { JA_ENTRIES, createTranslator } from '../i18n/index'
import { FakeClock } from '../testing/fakes'
import { sampleSnapshot } from '../testing/fixtures'
import { RendererLog } from './log'
import { formatDuration, remainingMs, selectMode, selectSlots } from './display'

/**
 * The four fixed slots (spec §5.2) and the mode badge (spec §6.4), projected
 * from the snapshot with an injected "now".
 */

const NOW = Date.parse('2026-08-17T00:00:00.000Z')

function translate() {
  return createTranslator(new RendererLog(new FakeClock()))
}

describe('remainingMs', () => {
  it('counts down to an absolute instant and stops at zero', () => {
    expect(remainingMs('2026-08-17T00:05:00.000Z', NOW)).toBe(300_000)
    expect(remainingMs('2026-08-16T23:00:00.000Z', NOW)).toBe(0)
  })

  it('treats an unparseable instant as elapsed instead of throwing', () => {
    expect(remainingMs('not-an-instant', NOW)).toBe(0)
  })
})

/**
 * The wording lives in `ja.json` and nowhere else (TASK_SPECS §T14 acceptance
 * 2), so the expectations below are built from the resource: what is asserted is
 * the unit chosen and the number in it, not a second copy of the Japanese.
 */
function expected(unit: 'seconds' | 'minutes' | 'hours', value: number): string {
  const template = JA_ENTRIES[`ui.duration.${unit}`]?.text ?? ''
  return template.replace(`{${unit}}`, String(value))
}

describe('formatDuration', () => {
  it('rounds up into one unit so a glance reads a single number', () => {
    const t = translate()
    expect(formatDuration(0, t)).toBe(expected('seconds', 0))
    expect(formatDuration(45_000, t)).toBe(expected('seconds', 45))
    // 59.4s rounds up to a full minute, so the unit changes with it.
    expect(formatDuration(59_400, t)).toBe(expected('minutes', 1))
    expect(formatDuration(60_000, t)).toBe(expected('minutes', 1))
    expect(formatDuration(301_000, t)).toBe(expected('minutes', 6))
    expect(formatDuration(3_600_000, t)).toBe(expected('hours', 1))
    expect(formatDuration(5_400_000, t)).toBe(expected('hours', 2))
  })
})

describe('selectSlots', () => {
  it('projects the four slots without exposing the world numbers', () => {
    const slots = selectSlots(sampleSnapshot(), NOW)

    expect(slots.need).toEqual({
      labelKey: 'ui.slot.needOrMission',
      textKey: 'sample.need_food',
      iconId: 'sample-icon-need',
    })
    expect(slots.action).toEqual({
      labelKey: 'ui.slot.lastAction',
      commandName: 'FEED',
      contributionCount: 12,
      appliedAt: '2026-08-17T00:00:30.000Z',
    })
    // The progress pair leaves as a ratio, and the chapter as beat marks.
    expect(slots.progress.ratio).toBeCloseTo(1 / 3, 5)
    expect(slots.progress.beatsPlayed).toBe(1)
    expect(slots.progress.beatCount).toBe(3)
    expect(slots.progress.stageTextKey).toBe('stage.sample-growth')
    expect(slots.nextChoice.remainingMs).toBe(600_000)
  })

  it('reports no action and no next choice instead of inventing them', () => {
    const snapshot = sampleSnapshot()
    const slots = selectSlots(
      { ...snapshot, display: { ...snapshot.display, lastAppliedAction: null, nextChoiceAt: null } },
      NOW,
    )

    expect(slots.action.commandName).toBeNull()
    expect(slots.action.contributionCount).toBe(0)
    expect(slots.nextChoice.at).toBeNull()
    expect(slots.nextChoice.remainingMs).toBeNull()
  })

  it('clamps a progress that overshoots or has no target', () => {
    const snapshot = sampleSnapshot()
    const overshoot = selectSlots(
      {
        ...snapshot,
        display: {
          ...snapshot.display,
          growthOrChapterProgress: {
            textKey: 'sample.chapter_progress',
            progress: { current: 30, target: 12 },
          },
        },
      },
      NOW,
    )
    expect(overshoot.progress.ratio).toBe(1)

    const empty = selectSlots(
      {
        ...snapshot,
        display: {
          ...snapshot.display,
          growthOrChapterProgress: {
            textKey: 'sample.chapter_progress',
            progress: { current: 0, target: 0 },
          },
        },
      },
      NOW,
    )
    expect(empty.progress.ratio).toBe(0)
  })
})

describe('selectMode', () => {
  it('reports the snapshot mode with no window and no tally', () => {
    const mode = selectMode(sampleSnapshot(), NOW)
    expect(mode).toEqual({
      mode: 'direct',
      labelKey: 'ui.mode.direct',
      windowOpen: false,
      remainingMs: null,
      tallies: [],
    })
  })

  it('reports the open window, its remaining time and its tally shares', () => {
    const snapshot = sampleSnapshot()
    const mode = selectMode(
      {
        ...snapshot,
        inputMode: 'aggregate',
        display: {
          ...snapshot.display,
          aggregateWindow: {
            mode: 'aggregate',
            endsAt: '2026-08-17T00:00:20.000Z',
            tallies: [
              { commandName: 'PLAY', count: 40 },
              { commandName: 'FEED', count: 10 },
              { commandName: 'PET', count: 0 },
            ],
          },
        },
      },
      NOW,
    )

    expect(mode.mode).toBe('aggregate')
    expect(mode.labelKey).toBe('ui.mode.aggregate')
    expect(mode.windowOpen).toBe(true)
    expect(mode.remainingMs).toBe(20_000)
    expect(mode.tallies).toEqual([
      { commandName: 'PLAY', count: 40, share: 1 },
      { commandName: 'FEED', count: 10, share: 0.25 },
      { commandName: 'PET', count: 0, share: 0 },
    ])
  })

  it('closes the window once its absolute end time has passed', () => {
    const snapshot = sampleSnapshot()
    const mode = selectMode(
      {
        ...snapshot,
        display: {
          ...snapshot.display,
          aggregateWindow: {
            mode: 'aggregate',
            endsAt: '2026-08-16T23:59:00.000Z',
            tallies: [{ commandName: 'PLAY', count: 3 }],
          },
        },
      },
      NOW,
    )

    expect(mode.windowOpen).toBe(false)
    expect(mode.remainingMs).toBe(0)
  })
})
