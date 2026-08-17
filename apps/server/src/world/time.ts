import type { IsoUtcInstant } from '@vl/contract'

import type { WorldPhaseId } from './types.js'

/**
 * Absolute-time helpers for the world model (spec §10.2: persisted times are UTC
 * absolute instants). Nothing here reads a clock — every function takes the
 * instant it works on, so the reducer stays pure and replayable.
 *
 * Japan observes no daylight saving time, so JST is a fixed +09:00 offset; the
 * broadcast's day and time-of-day are expressed in it (spec §5.3).
 */

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000
export const MILLIS_PER_MINUTE = 60_000
export const MILLIS_PER_HOUR = 60 * MILLIS_PER_MINUTE
export const MILLIS_PER_DAY = 24 * MILLIS_PER_HOUR

/** Parses an ISO UTC instant to epoch millis, refusing anything unparseable. */
export function toMillis(instant: IsoUtcInstant): number {
  const millis = Date.parse(instant)
  if (Number.isNaN(millis)) throw new TypeError(`not an instant: ${instant}`)
  return millis
}

export function toInstant(millis: number): IsoUtcInstant {
  if (!Number.isFinite(millis)) throw new TypeError(`not a finite epoch: ${String(millis)}`)
  return new Date(millis).toISOString()
}

export function addMillis(instant: IsoUtcInstant, millis: number): IsoUtcInstant {
  return toInstant(toMillis(instant) + millis)
}

/** `a - b` in milliseconds. Positive when `a` is later. */
export function millisBetween(a: IsoUtcInstant, b: IsoUtcInstant): number {
  return toMillis(a) - toMillis(b)
}

export function earliest(a: IsoUtcInstant, b: IsoUtcInstant): IsoUtcInstant {
  return toMillis(a) <= toMillis(b) ? a : b
}

/** JST calendar day number (days since the epoch in +09:00). */
export function jstDayIndex(instant: IsoUtcInstant): number {
  return Math.floor((toMillis(instant) + JST_OFFSET_MS) / MILLIS_PER_DAY)
}

/** Hour of the JST day, 0…23. */
export function jstHour(instant: IsoUtcInstant): number {
  const millisIntoDay = (toMillis(instant) + JST_OFFSET_MS) % MILLIS_PER_DAY
  return Math.floor(millisIntoDay / MILLIS_PER_HOUR)
}

/** The UTC instant of `hour:00` JST on the JST day that contains `instant`. */
export function jstHourOn(instant: IsoUtcInstant, hour: number): IsoUtcInstant {
  const dayStart = jstDayIndex(instant) * MILLIS_PER_DAY - JST_OFFSET_MS
  return toInstant(dayStart + hour * MILLIS_PER_HOUR)
}

/** The first `hour:00` JST strictly after `instant`. */
export function nextJstHour(instant: IsoUtcInstant, hour: number): IsoUtcInstant {
  const candidate = jstHourOn(instant, hour)
  if (toMillis(candidate) > toMillis(instant)) return candidate
  return toInstant(toMillis(candidate) + MILLIS_PER_DAY)
}

/**
 * JST hour each phase of the day begins at. The values are content design, not a
 * spec constant; they only have to partition the day and follow JST (spec §5.3).
 */
export const WORLD_PHASE_START_HOURS_JST = [
  { phase: 'dawn', hour: 4 },
  { phase: 'morning', hour: 7 },
  { phase: 'afternoon', hour: 12 },
  { phase: 'evening', hour: 17 },
  { phase: 'night', hour: 21 },
] as const satisfies ReadonlyArray<{ readonly phase: WorldPhaseId; readonly hour: number }>

export function worldPhaseAt(instant: IsoUtcInstant): WorldPhaseId {
  const hour = jstHour(instant)
  let phase: WorldPhaseId = 'night' // 00:00–03:59 JST belongs to the previous night
  for (const entry of WORLD_PHASE_START_HOURS_JST) {
    if (hour >= entry.hour) phase = entry.phase
  }
  return phase
}

/** Start of the next phase after `instant`, as an absolute instant. */
export function nextWorldPhaseAt(instant: IsoUtcInstant): IsoUtcInstant {
  let next: IsoUtcInstant | null = null
  for (const entry of WORLD_PHASE_START_HOURS_JST) {
    const candidate = jstHourOn(instant, entry.hour)
    if (toMillis(candidate) > toMillis(instant) && (next === null || toMillis(candidate) < toMillis(next))) {
      next = candidate
    }
  }
  // Past the last boundary of the JST day the next one is tomorrow's first.
  return next ?? nextJstHour(instant, WORLD_PHASE_START_HOURS_JST[0].hour)
}
