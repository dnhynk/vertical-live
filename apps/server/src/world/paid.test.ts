import { describe, expect, it } from 'vitest'

import { DEFAULT_WORLD_TUNING } from './content/tuning.js'
import { markThanksDelivered, paidFallbackDeadlines } from './paid.js'
import { initialWorldState, step, stepRngFor } from './reducer.js'
import { createRng } from './rng.js'
import { runWorld, type ScheduledEvent } from './run.js'
import { commandEvent, paidEvent } from './test-support.js'
import { MILLIS_PER_HOUR, addMillis } from './time.js'
import type { PaidThanksDraft, StepInput, WorldState } from './types.js'

const START = '2026-08-17T21:00:00.000Z'
const tuning = DEFAULT_WORLD_TUNING
const PAID_KINDS = ['SUPER_CHAT', 'SUPER_STICKER', 'GIFT', 'MEMBERSHIP'] as const

function fresh(seed = 'seed_test_paid'): WorldState {
  return initialWorldState({ seed, startedAt: START, identityGateOpen: false })
}

function apply(state: WorldState, input: StepInput, now: string) {
  return step(state, input, now, stepRngFor(state, input))
}

const freeEvents: readonly ScheduledEvent[] = [10, 47, 96, 155, 233].map((minutes) => {
  const at = addMillis(START, minutes * 60_000)
  const commands = ['FEED', 'PLAY', 'PET'] as const
  return { at, event: commandEvent(at, commands[minutes % 3] ?? 'FEED') }
})

describe('payment buys no game power (spec §8.5)', () => {
  it('leaves the world state referentially untouched in a single step', () => {
    const state = fresh()
    for (const kind of PAID_KINDS) {
      const at = addMillis(START, 60_000)
      const result = apply(state, { kind: 'event', event: paidEvent(at, kind) }, at)
      expect(result.state.world).toBe(state.world)
      expect(result.state.world.stepIndex).toBe(state.world.stepIndex)
      expect(result.effects.every((effect) => effect.kind === 'PAID_THANKS')).toBe(true)
    }
  })

  it('produces the same world over a run whether or not paid events are interleaved', () => {
    const to = addMillis(START, 6 * MILLIS_PER_HOUR)
    const rng = createRng('seed_test_paid_property')
    const paid: ScheduledEvent[] = []
    for (let index = 0; index < 40; index += 1) {
      const at = addMillis(START, rng.nextInt(6 * 60) * 60_000 + rng.nextInt(60) * 1_000)
      const kind = rng.pick(PAID_KINDS) ?? 'SUPER_CHAT'
      paid.push({
        at,
        event: paidEvent(at, kind, {
          amountMicros: rng.nextInt(1_000_000_000),
          tier: rng.nextInt(5) + 1,
          jewels: kind === 'GIFT' ? rng.nextInt(500) : null,
          comboCount: kind === 'GIFT' ? rng.nextInt(9) + 1 : null,
        }),
      })
    }

    const baseline = runWorld({ to, state: fresh(), events: freeEvents })
    const withPaid = runWorld({ to, state: fresh(), events: [...freeEvents, ...paid] })

    expect(withPaid.state.world).toEqual(baseline.state.world)
    expect(withPaid.transitions.filter((it) => it.cause !== 'paid')).toEqual(baseline.transitions)
    expect(withPaid.effects.filter((it) => !it.paid)).toEqual(baseline.effects)
  })

  it('does not move needs, growth, bond, votes or the branch', () => {
    const to = addMillis(START, 11 * MILLIS_PER_HOUR)
    const paid: ScheduledEvent[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((hour) => {
      const at = addMillis(START, hour * MILLIS_PER_HOUR)
      return { at, event: paidEvent(at, 'SUPER_CHAT', { tier: hour }) }
    })
    const baseline = runWorld({ to, state: fresh() })
    const withPaid = runWorld({ to, state: fresh(), events: paid })

    expect(withPaid.state.world.creature).toEqual(baseline.state.world.creature)
    expect(withPaid.state.world.chapter.branchChoiceId).toEqual(
      baseline.state.world.chapter.branchChoiceId,
    )
    expect(withPaid.state.world.environment).toEqual(baseline.state.world.environment)
  })
})

describe('fixed thanks staging (spec §8.4)', () => {
  it('stages the same fixed thanks for the same paid kind regardless of state', () => {
    const early = fresh()
    const late = runWorld({ to: addMillis(START, 5 * MILLIS_PER_HOUR), state: fresh() }).state
    const at = addMillis(START, 5 * MILLIS_PER_HOUR + 60_000)
    const event = paidEvent(at, 'GIFT')

    const first = apply(early, { kind: 'event', event }, at).effects[0] as PaidThanksDraft
    const second = apply(late, { kind: 'event', event }, at).effects[0] as PaidThanksDraft
    expect(second.payload).toEqual(first.payload)
    expect(first.payload.iconId).toBe('thanks_gift')
    expect(first.paid).toBe(true)
    expect(first.cause.kind).toBe('event')
  })

  it('names no person in the thanks payload (spec §12.3)', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const effect = apply(state, { kind: 'event', event: paidEvent(at, 'MEMBERSHIP') }, at)
      .effects[0] as PaidThanksDraft
    expect(Object.keys(effect.payload).sort()).toEqual([
      'fallback',
      'iconId',
      'paidEventKind',
      'tier',
    ])
  })
})

describe('substitute thanks (spec §9.2)', () => {
  it('owes a fallback timer once the original staging is committed', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const result = apply(state, { kind: 'event', event: paidEvent(at, 'SUPER_CHAT') }, at)

    expect((result.effects[0] as PaidThanksDraft).payload.fallback).toBe(false)
    expect(result.state.audit.pendingThanks).toHaveLength(1)
    const owed = result.deadlines.filter((it) => it.kind === 'paid_thanks_fallback')
    expect(owed).toHaveLength(1)
    expect(owed[0]?.policy).toBe('replay')
  })

  it('runs the substitute exactly once, and not again', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const staged = apply(state, { kind: 'event', event: paidEvent(at, 'SUPER_CHAT') }, at)
    const deadline = paidFallbackDeadlines(staged.state.audit)[0]
    expect(deadline).toBeDefined()
    if (deadline === undefined) return

    const fired = apply(staged.state, { kind: 'deadline', deadline }, deadline.dueAt)
    const fallbackEffects = fired.effects.filter(
      (effect): effect is PaidThanksDraft => effect.kind === 'PAID_THANKS',
    )
    expect(fallbackEffects).toHaveLength(1)
    expect(fallbackEffects[0]?.payload.fallback).toBe(true)
    expect(fired.state.audit.pendingThanks).toHaveLength(0)
    expect(fired.state.world).toBe(staged.state.world)

    const again = apply(fired.state, { kind: 'deadline', deadline }, deadline.dueAt)
    expect(again.effects).toHaveLength(0)
  })

  it('drops the obligation once the renderer confirmed the original', () => {
    const state = fresh()
    const at = addMillis(START, 60_000)
    const event = paidEvent(at, 'GIFT')
    const staged = apply(state, { kind: 'event', event }, at)
    const confirmed: WorldState = {
      world: staged.state.world,
      audit: markThanksDelivered(staged.state.audit, event.eventKey),
    }
    expect(paidFallbackDeadlines(confirmed.audit)).toHaveLength(0)
  })

  it('runs the substitute immediately for an event that arrived after its window', () => {
    const state = fresh()
    const occurredAt = addMillis(START, 60_000)
    const arrivedAt = addMillis(occurredAt, tuning.paid.originalStagingWindowMs + 60_000)
    const event = paidEvent(arrivedAt, 'SUPER_STICKER', {}, occurredAt)
    const result = apply(state, { kind: 'event', event }, arrivedAt)

    const effect = result.effects[0] as PaidThanksDraft
    expect(effect.payload.fallback).toBe(true)
    expect(result.state.audit.pendingThanks).toHaveLength(0)
    expect(result.state.world).toBe(state.world)
  })
})
