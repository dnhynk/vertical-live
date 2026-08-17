import { describe, expect, it } from 'vitest'

import {
  addMillis,
  earliest,
  jstDayIndex,
  jstHour,
  jstHourOn,
  millisBetween,
  nextJstHour,
  nextWorldPhaseAt,
  toInstant,
  toMillis,
  worldPhaseAt,
} from './time.js'

/**
 * JST is the broadcast's time base (spec §5.3) and Japan observes no daylight
 * saving time, so the offset is a fixed +09:00.
 */

describe('absolute time helpers (spec §10.2)', () => {
  it('round-trips an instant', () => {
    expect(toInstant(toMillis('2026-08-17T21:00:00.000Z'))).toBe('2026-08-17T21:00:00.000Z')
    expect(addMillis('2026-08-17T21:00:00.000Z', 3_600_000)).toBe('2026-08-17T22:00:00.000Z')
    expect(millisBetween('2026-08-17T22:00:00.000Z', '2026-08-17T21:00:00.000Z')).toBe(3_600_000)
    expect(earliest('2026-08-17T22:00:00.000Z', '2026-08-17T21:00:00.000Z')).toBe(
      '2026-08-17T21:00:00.000Z',
    )
  })

  it('refuses a value that is not an instant instead of guessing one', () => {
    expect(() => toMillis('not-a-time')).toThrow(/not an instant/)
    expect(() => toInstant(Number.NaN)).toThrow(/not a finite epoch/)
  })
})

describe('JST calendar (spec §5.3)', () => {
  it('reads the hour in +09:00', () => {
    expect(jstHour('2026-08-17T21:00:00.000Z')).toBe(6)
    expect(jstHour('2026-08-17T15:00:00.000Z')).toBe(0)
    expect(jstHour('2026-08-17T14:59:59.000Z')).toBe(23)
  })

  it('rolls the day at JST midnight, not UTC midnight', () => {
    expect(jstDayIndex('2026-08-17T14:59:59.000Z')).toBe(jstDayIndex('2026-08-17T05:00:00.000Z'))
    expect(jstDayIndex('2026-08-17T15:00:00.000Z')).toBe(
      jstDayIndex('2026-08-17T14:59:59.000Z') + 1,
    )
  })

  it('finds a JST hour on the day of an instant, and the next one after it', () => {
    expect(jstHourOn('2026-08-17T21:00:00.000Z', 6)).toBe('2026-08-17T21:00:00.000Z')
    // Exactly on the boundary counts as past, so the next one is a day later.
    expect(nextJstHour('2026-08-17T21:00:00.000Z', 6)).toBe('2026-08-18T21:00:00.000Z')
    expect(nextJstHour('2026-08-17T22:00:00.000Z', 6)).toBe('2026-08-18T21:00:00.000Z')
  })
})

describe('time of day', () => {
  it('names the phase of a JST hour', () => {
    const phaseAtJstHour = (hour: number): string =>
      worldPhaseAt(addMillis('2026-08-17T15:00:00.000Z', hour * 3_600_000))
    expect(phaseAtJstHour(2)).toBe('night')
    expect(phaseAtJstHour(5)).toBe('dawn')
    expect(phaseAtJstHour(9)).toBe('morning')
    expect(phaseAtJstHour(14)).toBe('afternoon')
    expect(phaseAtJstHour(18)).toBe('evening')
    expect(phaseAtJstHour(23)).toBe('night')
  })

  it('always moves forward to the next boundary', () => {
    let at = '2026-08-17T15:00:00.000Z'
    const seen: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const next = nextWorldPhaseAt(at)
      expect(toMillis(next)).toBeGreaterThan(toMillis(at))
      at = next
      seen.push(worldPhaseAt(at))
    }
    expect(new Set(seen).size).toBe(5)
  })
})
