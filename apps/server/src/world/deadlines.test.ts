import { describe, expect, it } from 'vitest'

import {
  DEADLINE_DEFINITIONS,
  deadlinePolicy,
  dueDeadlines,
  planDeadlineRecovery,
  removeDeadline,
  replaceDeadline,
  scheduleDeadline,
} from './deadlines.js'
import { DEADLINE_KINDS, type DeadlineKind, type DeadlinePolicyMap } from './types.js'

describe('deadline definitions (spec §10.2)', () => {
  it('gives every deadline kind exactly one downtime policy', () => {
    for (const kind of DEADLINE_KINDS) {
      const definition = DEADLINE_DEFINITIONS[kind]
      expect(definition.kind).toBe(kind)
      expect(['replay', 'coalesce', 'skip']).toContain(definition.policy)
      expect(definition.rationale.length).toBeGreaterThan(0)
    }
    expect(Object.keys(DEADLINE_DEFINITIONS).sort()).toEqual([...DEADLINE_KINDS].sort())
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
    const pending = [scheduleDeadline('visitor_arrival', at(1)), scheduleDeadline('idle_beat', at(2))]
    const plan = planDeadlineRecovery(pending, at(10))
    expect(plan.deliver).toHaveLength(0)
    expect(plan.expired.map((it) => it.kind)).toEqual(['visitor_arrival', 'idle_beat'])
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
