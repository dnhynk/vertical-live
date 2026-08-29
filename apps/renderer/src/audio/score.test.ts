import { describe, expect, it } from 'vitest'

import type { SceneConditions } from '../visual/palette'
import { CHIME_GAIN, MASTER_GAIN, SCALES, bellHz, chimeHzFor, scoreFor } from './score'

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

  /**
   * The first version shipped `hirajoshi` and `insen`, and the broadcast sounded
   * haunted. Their minor seconds are why: a semitone held against a drone is the
   * most unsettled interval there is. A scale with none cannot produce it, so
   * this is checked rather than left to taste.
   */
  it('uses no scale containing a semitone, in any inversion or against the octave', () => {
    for (const scale of Object.values(SCALES)) {
      expect(scale.degrees[0]).toBe(0)
      const wrapped = [...scale.degrees, 12]
      for (let i = 1; i < wrapped.length; i += 1) {
        const step = (wrapped[i] as number) - (wrapped[i - 1] as number)
        expect(step).toBeGreaterThan(1)
      }
    }
  })

  it('gives the drone a colour tone, so the chord is not a bare open fifth', () => {
    // Root and fifth alone are neither major nor minor, which is what read as
    // hollow on air. The score names a third interval for the drone to hold.
    const score = scoreFor(conditions())
    expect(score.droneColourSemitones).toBeGreaterThan(0)
    expect(score.droneColourSemitones).not.toBe(7)
    expect(score.droneColourSemitones).not.toBe(12)
  })

  it('keeps the drone detune small enough not to beat', () => {
    // A wide detune on a held chord is a slow wobble, which is a horror cue.
    for (const resting of [false, true]) {
      expect(scoreFor(conditions({ resting })).droneDetuneCents).toBeLessThanOrEqual(5)
    }
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

describe('chimeHzFor', () => {
  it('rings a different note for each free command, and always the same one', () => {
    const score = scoreFor(conditions())
    const feed = chimeHzFor(score, 'FEED')
    const play = chimeHzFor(score, 'PLAY')
    const pet = chimeHzFor(score, 'PET')
    expect(new Set([feed, play, pet]).size).toBe(3)
    expect(chimeHzFor(score, 'FEED')).toBe(feed)
  })

  it('pitches inside the scale, so an acknowledgement cannot clash with the chord', () => {
    const score = scoreFor(conditions())
    for (const command of ['FEED', 'PLAY', 'PET']) {
      const hz = chimeHzFor(score, command)
      expect(hz).not.toBeNull()
      const semitones = Math.round(12 * Math.log2((hz as number) / score.rootHz))
      expect(score.scale.degrees).toContain(((semitones % 12) + 12) % 12)
    }
  })

  /**
   * Spec §8.5: a paid event does not buy screen dominance, and it does not buy a
   * sound either. Nothing in this module reads a paid effect, and anything that
   * is not a free care command gets no note at all.
   */
  it('refuses to ring for anything that is not a free care command', () => {
    const score = scoreFor(conditions())
    for (const name of ['SUPER_CHAT', 'GIFT', 'MEMBERSHIP', 'VOTE_A', 'JOIN', '']) {
      expect(chimeHzFor(score, name)).toBeNull()
    }
  })

  it('stays quiet: a chime plus the bed is still under the master level', () => {
    const score = scoreFor(conditions())
    expect((score.droneGain + score.bellGain + CHIME_GAIN) * MASTER_GAIN).toBeLessThan(0.1)
  })
})
