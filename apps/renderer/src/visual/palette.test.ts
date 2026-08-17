import { describe, expect, it } from 'vitest'

import { sampleSnapshot } from '../testing/fixtures'
import {
  WAITING_PALETTE,
  mixColors,
  paletteFor,
  sceneConditions,
  selectPalette,
  type SceneConditions,
} from './palette'

/**
 * Visual variation by state, chapter and environment (spec §12.5), and the
 * fallback that keeps an unknown content identifier from breaking the broadcast.
 */

const BASE: SceneConditions = {
  worldPhaseId: 'afternoon',
  environmentId: 'garden',
  weatherId: 'clear',
  chapterId: 'gathering',
  emotionId: 'content',
  resting: false,
}

describe('mixColors', () => {
  it('mixes linearly and clamps the ratio', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixColors('#000000', '#ffffff', -1)).toBe('#000000')
    expect(mixColors('#000000', '#ffffff', 2)).toBe('#ffffff')
  })
})

describe('selectPalette', () => {
  it('gives a different picture to a different time of day', () => {
    const morning = selectPalette({ ...BASE, worldPhaseId: 'morning' })
    const night = selectPalette({ ...BASE, worldPhaseId: 'night' })

    expect(morning.skyTop).not.toBe(night.skyTop)
    expect(morning.keyIntensity).toBeGreaterThan(night.keyIntensity)
    expect(morning.paletteId).not.toBe(night.paletteId)
  })

  it('tints the ground with the place and the accent with the chapter', () => {
    const garden = selectPalette(BASE)
    const terrace = selectPalette({ ...BASE, environmentId: 'night_terrace' })
    expect(garden.skyBottom).not.toBe(terrace.skyBottom)
    expect(garden.rimColor).not.toBe(terrace.rimColor)

    expect(selectPalette({ ...BASE, chapterId: 'festival_prep' }).accent).not.toBe(garden.accent)
  })

  it('dims and slows the room in rain, and speeds it up in wind', () => {
    const clear = selectPalette(BASE)
    const rain = selectPalette({ ...BASE, weatherId: 'rain' })
    const wind = selectPalette({ ...BASE, weatherId: 'wind' })

    expect(rain.keyIntensity).toBeLessThan(clear.keyIntensity)
    expect(rain.motion).toBeGreaterThan(clear.motion)
    expect(wind.motion).toBeGreaterThan(rain.motion)
  })

  it('quiets the room while the creature is in a recoverable crisis', () => {
    const awake = selectPalette(BASE)
    const resting = selectPalette({ ...BASE, resting: true })

    expect(resting.keyIntensity).toBeLessThan(awake.keyIntensity)
    expect(resting.motion).toBeLessThan(awake.motion)
    // Quieter, not darker to the point of alarm: the creature is never at risk
    // (spec §6.3), so the light never goes out.
    expect(resting.ambientIntensity).toBeGreaterThan(0)
  })

  it('falls back to the neutral tables for identifiers it does not know', () => {
    const unknown = selectPalette({
      worldPhaseId: 'sample-unknown-phase',
      environmentId: 'sample-unknown-place',
      weatherId: 'sample-unknown-weather',
      chapterId: 'sample-unknown-chapter',
      emotionId: 'sample-unknown-mood',
      resting: false,
    })

    expect(unknown.skyTop).toBe(WAITING_PALETTE.skyTop)
    expect(unknown.keyIntensity).toBe(WAITING_PALETTE.keyIntensity)
    expect(unknown.accent).toBe(WAITING_PALETTE.accent)
    expect(unknown.motion).toBe(1)
  })

  it('is a pure function of its conditions', () => {
    expect(selectPalette(BASE)).toEqual(selectPalette({ ...BASE }))
  })
})

describe('sceneConditions', () => {
  it('reads the identifiers out of the snapshot and detects a crisis by its key', () => {
    const snapshot = sampleSnapshot()
    expect(sceneConditions(snapshot)).toEqual({
      worldPhaseId: 'sample-morning',
      environmentId: 'sample-room',
      weatherId: 'sample-clear',
      chapterId: 'sample-chapter',
      emotionId: 'sample-emotion',
      resting: false,
    })

    const inCrisis = sceneConditions({
      ...snapshot,
      display: {
        ...snapshot.display,
        currentNeedOrMission: { textKey: 'crisis.sleeping', iconId: 'icon_crisis_sleeping' },
      },
    })
    expect(inCrisis.resting).toBe(true)
  })

  it('uses the neutral palette until the first snapshot arrives', () => {
    expect(paletteFor(null)).toEqual(WAITING_PALETTE)
    expect(paletteFor(sampleSnapshot())).not.toEqual(WAITING_PALETTE)
  })
})
