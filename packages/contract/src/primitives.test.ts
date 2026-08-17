import { describe, expect, it } from 'vitest'

import { IsoUtcInstantSchema, toIsoUtcInstant } from './primitives.js'

/**
 * `publishedAt` / `published_at` are ISO 8601 date-times in [S3] and [S4], and
 * `occurredAt` is the absolute UTC instant the whole system orders events by
 * (spec §10.2). Accepting anything `Date.parse` happens to understand would put
 * a host-dependent, silently wrong time into the contract, so the normalizer is
 * pinned in both directions here.
 */

describe('toIsoUtcInstant accepts an ISO 8601 instant', () => {
  it.each([
    ['2026-08-16T00:00:00Z', '2026-08-16T00:00:00.000Z'],
    ['2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'],
    ['2026-08-16T00:00:00.123456789Z', '2026-08-16T00:00:00.123Z'],
    // RFC 3339 offsets are normalized to UTC; nothing else is stored (spec §10.2).
    ['2026-08-16T09:00:00+09:00', '2026-08-16T00:00:00.000Z'],
    ['2026-08-15T19:00:00-05:00', '2026-08-16T00:00:00.000Z'],
    ['2024-02-29T12:00:00Z', '2024-02-29T12:00:00.000Z'],
    ['2026-12-31T23:59:59Z', '2026-12-31T23:59:59.000Z'],
  ])('%s → %s', (input, expected) => {
    expect(toIsoUtcInstant(input)).toBe(expected)
    expect(IsoUtcInstantSchema.safeParse(toIsoUtcInstant(input)).success).toBe(true)
  })
})

describe('toIsoUtcInstant rejects anything that is not one', () => {
  it.each([
    // Values `Date.parse` accepts but ISO 8601 does not define this way.
    '0',
    '1',
    '08/17/2026',
    'Sat Aug 16 2026',
    'August 16, 2026',
    '2026',
    // A date is not an instant: it would silently become midnight UTC.
    '2026-08-17',
    // No time zone: the instant would depend on the host's zone.
    '2026-08-16T00:00:00',
    // Impossible calendar dates and clock times, which `Date.UTC` rolls over.
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-08-32T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-08-16T25:00:00Z',
    '2026-08-16T00:60:00Z',
    '2026-08-16T00:00:60Z',
    '2026-08-16T00:00:00+24:00',
    '2026-08-16T00:00:00+00:60',
    // Non-strings and empties.
    '',
    ' 2026-08-16T00:00:00Z',
    '2026-08-16T00:00:00Z ',
  ])('rejects %s', (input) => {
    expect(toIsoUtcInstant(input)).toBeNull()
  })

  it.each([null, undefined, 0, 1755302400000, {}, [], new Date('2026-08-16T00:00:00Z')])(
    'rejects the non-string %s',
    (input) => {
      expect(toIsoUtcInstant(input)).toBeNull()
    },
  )
})
