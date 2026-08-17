import type { CommandName, InputMode, WorldSnapshot } from '@vl/contract'

import type { Translate } from '../i18n/index'

/**
 * Pure projections of `snapshot.display` into what the four fixed slots draw
 * (spec §5.2) and what the input-mode badge draws (spec §6.4).
 *
 * Two rules shape everything below.
 *
 * 1. The screen answers the four questions of spec §5.2 and does not enumerate
 *    internal values: progress leaves here as a ratio and a beat count for a bar,
 *    never as the raw `current`/`target` pair the world keeps. The one number
 *    that stays a number is a participation count — spec §7.3 requires the
 *    contribution total to be preserved and §6.4 requires the tally of an open
 *    aggregate window to be on screen.
 * 2. Nothing is invented. Every field traces to a snapshot field, and "now" is
 *    passed in from the injected clock so the countdowns are testable.
 */

/** Milliseconds until an absolute instant, clamped at zero. */
export function remainingMs(untilIsoUtc: string, nowMs: number): number {
  const until = Date.parse(untilIsoUtc)
  if (Number.isNaN(until)) return 0
  return Math.max(0, until - nowMs)
}

/**
 * Coarse duration wording: one unit, rounded up, so a glance reads "あと5分"
 * rather than a clock. Below a minute it counts seconds, which is what makes an
 * aggregate window's remaining time useful (spec §6.4).
 */
export function formatDuration(ms: number, translate: Translate): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000))
  if (totalSeconds < 60) return translate('ui.duration.seconds', { seconds: totalSeconds })
  const totalMinutes = Math.ceil(totalSeconds / 60)
  if (totalMinutes < 60) return translate('ui.duration.minutes', { minutes: totalMinutes })
  return translate('ui.duration.hours', { hours: Math.ceil(totalMinutes / 60) })
}

export interface NeedSlotView {
  readonly labelKey: string
  readonly textKey: string
  readonly iconId: string
}

export interface ActionSlotView {
  readonly labelKey: string
  readonly commandName: CommandName | null
  readonly contributionCount: number
  readonly appliedAt: string | null
}

export interface ProgressSlotView {
  readonly labelKey: string
  readonly textKey: string
  readonly stageTextKey: string
  /** 0…1, for the growth bar. */
  readonly ratio: number
  /** Beats of the current chapter, for the segment dots (spec §6.2 start/turn/end). */
  readonly beatsPlayed: number
  readonly beatCount: number
}

export interface NextChoiceSlotView {
  readonly labelKey: string
  readonly at: string | null
  readonly remainingMs: number | null
}

export interface SlotViews {
  readonly need: NeedSlotView
  readonly action: ActionSlotView
  readonly progress: ProgressSlotView
  readonly nextChoice: NextChoiceSlotView
}

function ratioOf(progress: { current: number; target: number }): number {
  if (progress.target <= 0) return 0
  return Math.max(0, Math.min(1, progress.current / progress.target))
}

export function selectSlots(snapshot: WorldSnapshot, nowMs: number): SlotViews {
  const display = snapshot.display
  const nextChoiceAt = display.nextChoiceAt

  return {
    need: {
      labelKey: 'ui.slot.needOrMission',
      textKey: display.currentNeedOrMission.textKey,
      iconId: display.currentNeedOrMission.iconId,
    },
    action: {
      labelKey: 'ui.slot.lastAction',
      commandName: display.lastAppliedAction?.commandName ?? null,
      contributionCount: display.lastAppliedAction?.contributionCount ?? 0,
      appliedAt: display.lastAppliedAction?.appliedAt ?? null,
    },
    progress: {
      labelKey: 'ui.slot.progress',
      textKey: display.growthOrChapterProgress.textKey,
      // The growth ladder identifier is the content director's (T7); the key is
      // resolved like any other, so an unknown stage shows as its key.
      stageTextKey: `stage.${snapshot.creature.growthStage}`,
      ratio: ratioOf(display.growthOrChapterProgress.progress),
      beatsPlayed: Math.max(0, snapshot.environment.chapterProgress.current),
      beatCount: Math.max(0, snapshot.environment.chapterProgress.target),
    },
    nextChoice: {
      labelKey: 'ui.slot.nextChoice',
      at: nextChoiceAt,
      remainingMs: nextChoiceAt === null ? null : remainingMs(nextChoiceAt, nowMs),
    },
  }
}

export interface TallyView {
  readonly commandName: CommandName
  readonly count: number
  /** 0…1 against the largest tally in the window, for the bar width. */
  readonly share: number
}

/**
 * Current input mode and, while an aggregate window is open, its remaining time
 * and its tally (spec §6.4). The counts are room totals: no per-user fairness is
 * claimed while the identity gate is closed (BOARD A-1).
 */
export interface ModeView {
  readonly mode: InputMode
  readonly labelKey: string
  readonly windowOpen: boolean
  readonly remainingMs: number | null
  readonly tallies: readonly TallyView[]
}

const MODE_LABEL_KEYS: Readonly<Record<InputMode, string>> = {
  direct: 'ui.mode.direct',
  aggregate: 'ui.mode.aggregate',
}

export function selectMode(snapshot: WorldSnapshot, nowMs: number): ModeView {
  const window = snapshot.display.aggregateWindow
  // The window carries the mode it was opened in; outside one the snapshot's
  // `inputMode` is the authority. They agree in practice — this only decides
  // which field is read, never invents a mode.
  const mode = window?.mode ?? snapshot.inputMode
  if (window === undefined) {
    return {
      mode,
      labelKey: MODE_LABEL_KEYS[mode],
      windowOpen: false,
      remainingMs: null,
      tallies: [],
    }
  }

  const remaining = remainingMs(window.endsAt, nowMs)
  const highest = window.tallies.reduce((max, tally) => Math.max(max, tally.count), 0)
  return {
    mode,
    labelKey: MODE_LABEL_KEYS[mode],
    windowOpen: remaining > 0,
    remainingMs: remaining,
    tallies: window.tallies.map((tally) => ({
      commandName: tally.commandName,
      count: tally.count,
      share: highest === 0 ? 0 : tally.count / highest,
    })),
  }
}
