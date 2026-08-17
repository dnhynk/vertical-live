import { describe, expect, it } from 'vitest'

import {
  DEADLINE_DEFINITIONS,
  deadlinePolicy,
  dueDeadlines,
  nextDueAfterSkip,
  planDeadlineRecovery,
  removeDeadline,
  replaceDeadline,
  scheduleDeadline,
} from './deadlines.js'
import {
  initialWorldState,
  pendingDeadlines,
  recoverDeadlines,
  step,
  stepRngFor,
} from './reducer.js'
import { runWorld } from './run.js'
import { MILLIS_PER_HOUR, addMillis, toMillis } from './time.js'
import {
  DEADLINE_KINDS,
  type DeadlineKind,
  type DeadlinePolicyMap,
  type ScheduledDeadline,
  type StepInput,
  type WorldState,
} from './types.js'

describe('deadline definitions (spec §10.2)', () => {
  it('gives every deadline kind exactly one downtime policy', () => {
    for (const kind of DEADLINE_KINDS) {
      const definition = DEADLINE_DEFINITIONS[kind]
      expect(definition.kind).toBe(kind)
      expect(['replay', 'coalesce', 'skip']).toContain(definition.policy)
      expect(['interval', 'state', 'one_shot']).toContain(definition.recurrence)
      expect(definition.rationale.length).toBeGreaterThan(0)
    }
    expect(Object.keys(DEADLINE_DEFINITIONS).sort()).toEqual([...DEADLINE_KINDS].sort())
  })

  it('only gives `skip` to a kind recovery can re-arm (spec §2.1)', () => {
    // A dropped occurrence must never end a recurrence, so every `skip` kind has
    // to have a cadence recovery can recompute from the tuning and `now` alone.
    for (const kind of DEADLINE_KINDS) {
      if (DEADLINE_DEFINITIONS[kind].policy !== 'skip') continue
      expect(DEADLINE_DEFINITIONS[kind].recurrence).toBe('interval')
      expect(nextDueAfterSkip(kind, '2026-08-17T00:00:00.000Z')).not.toBe(null)
    }
  })

  it('re-arms only the interval kinds', () => {
    const now = '2026-08-17T00:00:00.000Z'
    for (const kind of DEADLINE_KINDS) {
      const nextDueAt = nextDueAfterSkip(kind, now)
      if (DEADLINE_DEFINITIONS[kind].recurrence === 'interval') {
        expect(nextDueAt).not.toBe(null)
        expect(toMillis(nextDueAt ?? now)).toBeGreaterThan(toMillis(now))
      } else {
        expect(nextDueAt).toBe(null)
      }
    }
  })

  it('fails to compile when a kind has no policy (TASK_SPECS §T7 acceptance 4)', () => {
    // @ts-expect-error — a policy map missing `need_decay` (and the rest) is a
    // type error, which is what makes `DEADLINE_DEFINITIONS` exhaustive.
    const incomplete: DeadlinePolicyMap = { idle_beat: 'skip' }
    expect(incomplete.idle_beat).toBe('skip')

    const complete: DeadlinePolicyMap = Object.fromEntries(
      DEADLINE_KINDS.map((kind) => [kind, deadlinePolicy(kind)]),
    ) as DeadlinePolicyMap
    expect(Object.keys(complete)).toHaveLength(DEADLINE_KINDS.length)
  })

  it('stamps the policy onto every scheduled deadline', () => {
    for (const kind of DEADLINE_KINDS) {
      const scheduled = scheduleDeadline(kind, '2026-08-17T00:00:00.000Z')
      expect(scheduled.policy).toBe(DEADLINE_DEFINITIONS[kind].policy)
    }
  })
})

describe('schedule bookkeeping', () => {
  const at = (minutes: number): string =>
    new Date(Date.parse('2026-08-17T00:00:00.000Z') + minutes * 60_000).toISOString()

  it('replaces a pending deadline of the same kind and key', () => {
    const first = scheduleDeadline('idle_beat', at(1))
    const second = scheduleDeadline('idle_beat', at(2))
    const pending = replaceDeadline([first], second)
    expect(pending).toEqual([second])
  })

  it('keeps deadlines of the same kind with different keys apart', () => {
    const setup = scheduleDeadline('chapter_beat', at(1), 'setup')
    const turn = scheduleDeadline('chapter_beat', at(2), 'turn')
    expect(replaceDeadline([setup], turn)).toEqual([setup, turn])
  })

  it('returns the same array when there is nothing to remove', () => {
    const pending = [scheduleDeadline('idle_beat', at(1))]
    expect(removeDeadline(pending, 'need_decay')).toBe(pending)
  })

  it('lists due deadlines in due order', () => {
    const pending = [
      scheduleDeadline('weather_change', at(30)),
      scheduleDeadline('idle_beat', at(1)),
      scheduleDeadline('need_decay', at(2)),
    ]
    expect(dueDeadlines(pending, at(3)).map((it) => it.kind)).toEqual(['idle_beat', 'need_decay'])
  })
})

describe('downtime recovery policies (spec §10.2)', () => {
  const at = (minutes: number): string =>
    new Date(Date.parse('2026-08-17T00:00:00.000Z') + minutes * 60_000).toISOString()

  it('replays every missed occurrence of a replay kind', () => {
    const pending = [
      scheduleDeadline('paid_thanks_fallback', at(1), 'simulator:bc_test_1:msg_test_0001'),
      scheduleDeadline('paid_thanks_fallback', at(2), 'simulator:bc_test_1:msg_test_0002'),
    ]
    const plan = planDeadlineRecovery(pending, at(10))
    expect(plan.deliver).toHaveLength(2)
    expect(plan.expired).toHaveLength(0)
  })

  it('coalesces a coalesce kind to its last missed occurrence', () => {
    const pending = [
      scheduleDeadline('need_decay', at(1)),
      scheduleDeadline('need_decay', at(2)),
      scheduleDeadline('need_decay', at(3)),
    ]
    const plan = planDeadlineRecovery(pending, at(10))
    expect(plan.deliver).toEqual([scheduleDeadline('need_decay', at(3))])
    expect(plan.expired).toHaveLength(2)
  })

  it('expires a skip kind instead of staging it late', () => {
    const pending = [
      scheduleDeadline('visitor_arrival', at(1)),
      scheduleDeadline('idle_beat', at(2)),
    ]
    const plan = planDeadlineRecovery(pending, at(10))
    expect(plan.deliver).toHaveLength(0)
    expect(plan.expired.map((it) => it.kind)).toEqual(['visitor_arrival', 'idle_beat'])
  })

  it('removes a skipped occurrence and re-arms the kind (spec §2.1, §10.2)', () => {
    const skipped = scheduleDeadline('idle_beat', at(2))
    const plan = planDeadlineRecovery([skipped, scheduleDeadline('visitor_arrival', at(1))], at(10))

    // Gone from the pending set…
    expect(plan.pending).not.toContainEqual(skipped)
    // …and both skip kinds have exactly one successor, in the future.
    expect(plan.rescheduled.map((it) => it.kind).sort()).toEqual(['idle_beat', 'visitor_arrival'])
    for (const kind of ['idle_beat', 'visitor_arrival'] as const) {
      const successors = plan.pending.filter((it) => it.kind === kind)
      expect(successors).toHaveLength(1)
      expect(toMillis(successors[0]?.dueAt ?? at(0))).toBeGreaterThan(toMillis(at(10)))
    }
  })

  it('collapses many missed occurrences of one skip kind into a single successor', () => {
    const pending = [1, 2, 3, 4].map((minute) => scheduleDeadline('idle_beat', at(minute)))
    const plan = planDeadlineRecovery(pending, at(10))
    expect(plan.expired).toHaveLength(4)
    expect(plan.rescheduled).toHaveLength(1)
    expect(plan.pending).toHaveLength(1)
  })

  it('drops every fired timer from the pending set and keeps the rest', () => {
    const later = scheduleDeadline('weather_change', at(90))
    const plan = planDeadlineRecovery(
      [
        scheduleDeadline('need_decay', at(1)),
        scheduleDeadline('chapter_beat', at(2), 'turn'),
        later,
      ],
      at(10),
    )
    // Delivered timers are re-armed by their own handler when they are stepped,
    // so they are not carried over here; the untouched one is.
    expect(plan.pending).toEqual([later])
  })

  it('leaves deadlines that are not due yet pending', () => {
    const plan = planDeadlineRecovery([scheduleDeadline('need_decay', at(30))], at(10))
    expect(plan.deliver).toHaveLength(0)
    expect(plan.expired).toHaveLength(0)
  })

  it('delivers a mixed recovery in due order', () => {
    const pending = [
      scheduleDeadline('chapter_beat', at(5), 'turn'),
      scheduleDeadline('need_decay', at(1)),
      scheduleDeadline('idle_beat', at(2)),
    ]
    const kinds = planDeadlineRecovery(pending, at(10)).deliver.map(
      (deadline: { kind: DeadlineKind }) => deadline.kind,
    )
    expect(kinds).toEqual(['need_decay', 'chapter_beat'])
  })
})

describe('world recovery after downtime (spec §7.3(3), §10.2)', () => {
  const START = '2026-08-17T21:00:00.000Z'

  function fresh(): WorldState {
    return initialWorldState({ seed: 'seed_test_recovery', startedAt: START })
  }

  it('leaves no skipped idle timer behind and keeps the world breathing', () => {
    const state = fresh()
    const now = addMillis(START, 2 * MILLIS_PER_HOUR)
    const idleBefore = pendingDeadlines(state).filter((it) => it.kind === 'idle_beat')
    expect(idleBefore).toHaveLength(1)

    const { state: recovered, plan } = recoverDeadlines(state, now)

    // The overdue idle beat is expired, not delivered late…
    expect(plan.expired.some((it) => it.kind === 'idle_beat')).toBe(true)
    expect(plan.deliver.some((it) => it.kind === 'idle_beat')).toBe(false)
    // …the very deadline that was pending is gone…
    const pendingAfter = pendingDeadlines(recovered)
    expect(pendingAfter).not.toContainEqual(idleBefore[0])
    // …and a successor is armed for the future, so spec §2.1 still holds.
    const idleAfter = pendingAfter.filter((it) => it.kind === 'idle_beat')
    expect(idleAfter).toHaveLength(1)
    expect(toMillis(idleAfter[0]?.dueAt ?? START)).toBeGreaterThan(toMillis(now))
  })

  it('hands T8 a plan it can apply without inventing domain behaviour', () => {
    const state = fresh()
    const now = addMillis(START, 2 * MILLIS_PER_HOUR)
    const { state: recovered, plan } = recoverDeadlines(state, now)

    // Exactly what the engine does: store the plan's state, step `deliver` in
    // order, record `expired`. Nothing else.
    let current = recovered
    for (const deadline of plan.deliver) {
      const input: StepInput = { kind: 'deadline', deadline }
      current = step(current, input, now, stepRngFor(current, input)).state
    }
    expect(plan.deliver.map((it: ScheduledDeadline) => it.kind)).toContain('chapter_beat')

    const run = runWorld({ to: addMillis(now, MILLIS_PER_HOUR), state: current })
    expect(run.transitions.some((it) => it.type === 'idle_beat')).toBe(true)
    // Every kind that was pending before the downtime is pending again.
    const kindsAfter = new Set(pendingDeadlines(run.state).map((it) => it.kind))
    for (const kind of new Set(pendingDeadlines(fresh()).map((it) => it.kind))) {
      expect(kindsAfter).toContain(kind)
    }
  })

  it('keeps paid obligations out of the world schedule while recovering', () => {
    const state = fresh()
    const now = addMillis(START, 2 * MILLIS_PER_HOUR)
    const { state: recovered, plan } = recoverDeadlines(state, now)
    expect(plan.expired.every((it) => it.kind !== 'paid_thanks_fallback')).toBe(true)
    expect(recovered.world.deadlines.every((it) => it.kind !== 'paid_thanks_fallback')).toBe(true)
  })
})
