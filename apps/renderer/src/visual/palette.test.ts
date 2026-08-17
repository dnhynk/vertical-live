// The consumption check at the bottom reads two component sources from disk.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

  it('tints the ground and the rim light with the place', () => {
    const garden = selectPalette(BASE)
    const terrace = selectPalette({ ...BASE, environmentId: 'night_terrace' })
    expect(garden.skyBottom).not.toBe(terrace.skyBottom)
    expect(garden.rimColor).not.toBe(terrace.rimColor)
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

/**
 * Review round 1, major 1: a chapter has to change the picture, not just the HUD
 * accent. These vary **only** `chapterId` — everything else in `BASE` is held
 * fixed — and check the fields the scene actually draws with.
 */
describe('chapter variation (spec §6.2 day scale, §12.5)', () => {
  const CHAPTERS = ['gathering', 'festival_prep', 'growth_choice'] as const

  /** Largest per-channel distance, so a rounding-level "difference" cannot pass. */
  function distance(left: string, right: string): number {
    const channels = (hex: string): number[] =>
      [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
    const a = channels(left)
    const b = channels(right)
    return Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? 0))))
  }

  it('changes the background and the lights, not only the accent', () => {
    for (const first of CHAPTERS) {
      for (const second of CHAPTERS) {
        if (first === second) continue
        const a = selectPalette({ ...BASE, chapterId: first })
        const b = selectPalette({ ...BASE, chapterId: second })
        const label = `${first} vs ${second}`

        // Background.tsx uniforms.
        expect(distance(a.skyTop, b.skyTop), label).toBeGreaterThanOrEqual(6)
        expect(distance(a.skyMid, b.skyMid), label).toBeGreaterThanOrEqual(6)
        expect(distance(a.skyBottom, b.skyBottom), label).toBeGreaterThanOrEqual(6)
        // Scene.tsx rim light.
        expect(distance(a.rimColor, b.rimColor), label).toBeGreaterThanOrEqual(6)
        expect(a.rimIntensity, label).not.toBe(b.rimIntensity)
        // And the HUD accent it already changed.
        expect(a.accent, label).not.toBe(b.accent)
      }
    }
  })

  it('holds everything else steady, so only the day moved', () => {
    const gathering = selectPalette({ ...BASE, chapterId: 'gathering' })
    const festival = selectPalette({ ...BASE, chapterId: 'festival_prep' })

    expect(gathering.keyIntensity).toBe(festival.keyIntensity)
    expect(gathering.ambientIntensity).toBe(festival.ambientIntensity)
    expect(gathering.motion).toBe(festival.motion)
  })

  it('leaves the room alone for a chapter it does not know', () => {
    const unknown = selectPalette({ ...BASE, chapterId: 'sample-chapter-from-the-future' })
    const neutral = selectPalette({ ...BASE, chapterId: '' })

    expect(unknown.skyTop).toBe(neutral.skyTop)
    expect(unknown.rimColor).toBe(neutral.rimColor)
    expect(unknown.rimIntensity).toBe(neutral.rimIntensity)
    expect(unknown.accent).toBe(neutral.accent)
  })

  it('moves fields the scene really draws with', () => {
    // The assertions above are only worth something if these are the fields
    // `Background.tsx` and `Scene.tsx` read off the palette.
    const components = join(dirname(fileURLToPath(import.meta.url)), '..', 'components')
    const background = readFileSync(join(components, 'Background.tsx'), 'utf8')
    const scene = readFileSync(join(components, 'Scene.tsx'), 'utf8')

    for (const field of ['skyTop', 'skyMid', 'skyBottom']) {
      expect(background.includes(`palette.${field}`), field).toBe(true)
    }
    for (const field of ['rimColor', 'rimIntensity']) {
      expect(scene.includes(`palette.${field}`), field).toBe(true)
    }
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
