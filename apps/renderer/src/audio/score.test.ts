import { describe, expect, it } from 'vitest'

import type { SceneConditions } from '../visual/palette'
import { MASTER_GAIN, SCALES, bellHz, scoreFor } from './score'

function conditions(overrides: Partial<SceneConditions> = {}): SceneConditions {
  return {
    worldPhaseId: 'day',
    environmentId: 'meadow',
    weatherId: 'clear',
    chapterId: 'gathering',
    emotionId: 'content',
    resting: false,
    ...overrides,
  }
}

describe('scoreFor', () => {
  it('is pure: the same world sounds the same', () => {
    expect(scoreFor(conditions())).toEqual(scoreFor(conditions()))
  })

  it('moves the root down and closes the room as the day ends', () => {
    const day = scoreFor(conditions({ worldPhaseId: 'day' }))
    const night = scoreFor(conditions({ worldPhaseId: 'night' }))
    expect(night.rootHz).toBeLessThan(day.rootHz)
    expect(night.cutoffHz).toBeLessThan(day.cutoffHz)
  })

  it('lets weather take the top off and slow the pace, the way it does the light', () => {
    const clear = scoreFor(conditions({ weatherId: 'clear' }))
    const rain = scoreFor(conditions({ weatherId: 'rain' }))
    expect(rain.cutoffHz).toBeLessThan(clear.cutoffHz)
    expect(rain.bellIntervalSec).toBeGreaterThan(clear.bellIntervalSec)
  })

  it('lets mood change the pace and nothing else — a mood is not a key change', () => {
    const content = scoreFor(conditions({ emotionId: 'content' }))
    const sleepy = scoreFor(conditions({ emotionId: 'sleepy' }))
    expect(sleepy.bellIntervalSec).toBeGreaterThan(content.bellIntervalSec)
    expect(sleepy.rootHz).toBe(content.rootHz)
    expect(sleepy.scale).toBe(content.scale)
  })

  /**
   * Spec §6.3: the creature is never actually at risk, so a crisis must not
   * sound like one. The room withdraws — quieter, darker, slower — rather than
   * doing anything an alarm would do.
   */
  it('goes quieter in a crisis, never louder or faster', () => {
    const awake = scoreFor(conditions({ resting: false }))
    const resting = scoreFor(conditions({ resting: true }))
    expect(resting.droneGain).toBeLessThan(awake.droneGain)
    expect(resting.bellGain).toBeLessThan(awake.bellGain)
    expect(resting.cutoffHz).toBeLessThan(awake.cutoffHz)
    expect(resting.bellIntervalSec).toBeGreaterThan(awake.bellIntervalSec)
  })

  it('falls back rather than throwing on an identifier it has never seen', () => {
    const unknown = scoreFor(
      conditions({ worldPhaseId: 'no_such_phase', weatherId: 'no_such_weather' }),
    )
    expect(unknown.rootHz).toBeGreaterThan(0)
    expect(unknown.cutoffHz).toBeGreaterThan(0)
    expect(unknown.bellIntervalSec).toBeGreaterThan(0)
  })

  it('keeps every level under the master gain, which is itself quiet', () => {
    // The one failure that matters for a stream nobody asked sound from is being
    // loud. Both voices together, at full master, stay well under unity.
    for (const phase of ['dawn', 'morning', 'day', 'afternoon', 'dusk', 'night']) {
      const score = scoreFor(conditions({ worldPhaseId: phase }))
      expect((score.droneGain + score.bellGain) * MASTER_GAIN).toBeLessThan(0.1)
    }
    expect(MASTER_GAIN).toBeLessThan(0.2)
  })

  it('never picks a scale with a leading tone into the root', () => {
    // A semitone below the octave is what makes a phrase resolve like a jingle,
    // which spec §5.3 rules out along with 동요.
    for (const scale of Object.values(SCALES)) {
      expect(scale.degrees).not.toContain(11 - 12)
      expect(scale.degrees[0]).toBe(0)
    }
    expect(SCALES['lydian']?.degrees).toContain(11)
  })
})

describe('bellHz', () => {
  it('is seeded, not random: the same step is always the same pitch', () => {
    const score = scoreFor(conditions())
    expect(bellHz(score, 7)).toBe(bellHz(score, 7))
  })

  it('does not walk the scale in order', () => {
    const score = scoreFor(conditions())
    const first = [0, 1, 2, 3, 4].map((step) => bellHz(score, step))
    const ascending = [...first].sort((a, b) => a - b)
    expect(first).not.toEqual(ascending)
  })

  it('stays above the drone and inside audible range', () => {
    const score = scoreFor(conditions())
    for (let step = 0; step < 64; step += 1) {
      const hz = bellHz(score, step)
      expect(hz).toBeGreaterThan(score.rootHz)
      expect(hz).toBeLessThan(20_000)
    }
  })
})
