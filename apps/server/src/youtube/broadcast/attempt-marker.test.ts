import { describe, expect, it } from 'vitest'

import {
  ATTEMPT_MARKER_PREFIX,
  BROADCAST_DESCRIPTION_MAX_LENGTH,
  attemptMarkerOf,
  carriesAttemptMarker,
  describeWithMarker,
} from './attempt-marker.js'

/**
 * The identity a `liveBroadcasts.insert` reconcile matches on (review round 2, B1).
 * The rules that matter: the marker always survives into the description, and a
 * description that does not carry it is never mistaken for this attempt's result.
 */

describe('attemptMarkerOf', () => {
  it('is derived from the attempt id and carries the stable prefix', () => {
    expect(attemptMarkerOf('attempt-0001')).toBe(`${ATTEMPT_MARKER_PREFIX}attempt-0001`)
    expect(attemptMarkerOf('a')).not.toBe(attemptMarkerOf('b'))
  })
})

describe('describeWithMarker', () => {
  it('appends the marker as the last line, keeping the operator text', () => {
    expect(describeWithMarker('a synthetic description', 'vl-attempt:x')).toBe(
      'a synthetic description\n\nvl-attempt:x',
    )
  })

  it('sends the marker alone when there is no description', () => {
    expect(describeWithMarker('', 'vl-attempt:x')).toBe('vl-attempt:x')
  })

  it('truncates the operator text rather than the marker at the documented limit', () => {
    const marker = 'vl-attempt:x'
    const long = 'd'.repeat(BROADCAST_DESCRIPTION_MAX_LENGTH + 500)

    const described = describeWithMarker(long, marker)

    // A description that lost its marker would be an unreconcilable broadcast.
    expect(described.length).toBe(BROADCAST_DESCRIPTION_MAX_LENGTH)
    expect(described.endsWith(`\n\n${marker}`)).toBe(true)
  })

  it('refuses a marker that cannot fit at all', () => {
    expect(() => describeWithMarker('', 'x'.repeat(BROADCAST_DESCRIPTION_MAX_LENGTH + 1))).toThrow(
      /does not fit/,
    )
  })
})

describe('carriesAttemptMarker', () => {
  it('matches the marker anywhere in the description', () => {
    expect(carriesAttemptMarker('text\n\nvl-attempt:x', 'vl-attempt:x')).toBe(true)
    expect(carriesAttemptMarker('vl-attempt:x\ntrailing platform text', 'vl-attempt:x')).toBe(true)
  })

  it('does not match another attempt, a prefix, or an absent description', () => {
    expect(carriesAttemptMarker('vl-attempt:y', 'vl-attempt:x')).toBe(false)
    expect(carriesAttemptMarker(ATTEMPT_MARKER_PREFIX, 'vl-attempt:x')).toBe(false)
    expect(carriesAttemptMarker('', 'vl-attempt:x')).toBe(false)
    expect(carriesAttemptMarker(null, 'vl-attempt:x')).toBe(false)
  })
})
