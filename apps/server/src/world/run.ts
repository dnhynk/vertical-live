import type { CanonicalEvent, IsoUtcInstant } from '@vl/contract'

import { DEFAULT_WORLD_TUNING, type WorldTuning } from './content/tuning.js'
import { dueDeadlines } from './deadlines.js'
import {
  initialWorldState,
  pendingDeadlines,
  step,
  stepRngFor,
  type InitialWorldOptions,
} from './reducer.js'
import { toMillis } from './time.js'
import type {
  EffectDraft,
  InputRejection,
  ScheduledDeadline,
  StepInput,
  WorldState,
  WorldTransition,
} from './types.js'

/**
 * An in-memory driver over `step()`. It merges scheduled events and due
 * deadlines in time order, exactly as the single-writer engine will, but with no
 * persistence, no WebSocket and no clock — it takes the window to run.
 *
 * This is what the acceptance tests drive a virtual 24 hours with, and what the
 * simulator (T11) can reuse. The production loop, with its transaction, outbox
 * and ACK tracking, is T8's engine and is deliberately not attempted here.
 */

export interface ScheduledEvent {
  readonly at: IsoUtcInstant
  readonly event: CanonicalEvent
  readonly contributions?: number
}

export interface RunOptions {
  /** Absolute end of the window. The start is wherever the state already is. */
  readonly to: IsoUtcInstant
  readonly state: WorldState
  readonly events?: readonly ScheduledEvent[]
  readonly tuning?: WorldTuning
  /** Runaway guard; the run stops and reports when it is hit. */
  readonly maxSteps?: number
}

export interface RunReport {
  readonly state: WorldState
  readonly transitions: readonly WorldTransition[]
  readonly effects: readonly EffectDraft[]
  readonly rejections: readonly InputRejection[]
  readonly steps: number
  readonly stoppedEarly: boolean
}

const DEFAULT_MAX_STEPS = 200_000

export function runWorld(options: RunOptions): RunReport {
  const tuning = options.tuning ?? DEFAULT_WORLD_TUNING
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const until = toMillis(options.to)

  const pendingEvents = [...(options.events ?? [])].sort((a, b) => toMillis(a.at) - toMillis(b.at))
  let eventIndex = 0
  let state = options.state
  const transitions: WorldTransition[] = []
  const effects: EffectDraft[] = []
  const rejections: InputRejection[] = []
  let steps = 0

  const nextDeadline = (): ScheduledDeadline | null => {
    let earliest: ScheduledDeadline | null = null
    for (const deadline of pendingDeadlines(state)) {
      if (earliest === null || toMillis(deadline.dueAt) < toMillis(earliest.dueAt)) {
        earliest = deadline
      }
    }
    return earliest
  }

  while (steps < maxSteps) {
    const upcomingEvent = pendingEvents[eventIndex] ?? null
    const deadline = nextDeadline()
    const eventAt = upcomingEvent === null ? Infinity : toMillis(upcomingEvent.at)
    const deadlineAt = deadline === null ? Infinity : toMillis(deadline.dueAt)
    const at = Math.min(eventAt, deadlineAt)
    if (!Number.isFinite(at) || at > until) break

    let input: StepInput
    let now: IsoUtcInstant
    // Events win a tie: an input that arrived at the same instant is applied to
    // the state the viewer could see, before the timer moves it on.
    if (upcomingEvent !== null && eventAt <= deadlineAt) {
      input = {
        kind: 'event',
        event: upcomingEvent.event,
        contributions: upcomingEvent.contributions,
      }
      now = upcomingEvent.at
      eventIndex += 1
    } else if (deadline !== null) {
      input = { kind: 'deadline', deadline }
      now = deadline.dueAt
    } else {
      break
    }

    const result = step(state, input, now, stepRngFor(state, input), { tuning })
    state = result.state
    transitions.push(...result.transitions)
    effects.push(...result.effects)
    rejections.push(...result.rejections)
    steps += 1
  }

  return { state, transitions, effects, rejections, steps, stoppedEarly: steps >= maxSteps }
}

/** Cold-starts a world and runs it for a window, in one call. */
export function runFreshWorld(
  options: InitialWorldOptions & {
    readonly to: IsoUtcInstant
    readonly events?: readonly ScheduledEvent[]
  },
): RunReport {
  const state = initialWorldState(options)
  return runWorld({
    to: options.to,
    state,
    events: options.events,
    tuning: options.tuning,
  })
}

/** Deadlines that are already due at `now`, for the recovery path of §7.3(3). */
export function overdueDeadlines(
  state: WorldState,
  now: IsoUtcInstant,
): readonly ScheduledDeadline[] {
  return dueDeadlines(pendingDeadlines(state), now)
}
