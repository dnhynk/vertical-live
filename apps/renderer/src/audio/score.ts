import type { SceneConditions } from '../visual/palette'

/**
 * What the room sounds like, decided from the same `SceneConditions` the palette
 * colours it from — so the sound cannot drift away from the picture, and a state
 * that changes the sky changes the air with it.
 *
 * This module makes every decision and touches no Web Audio API, which is why it
 * is the part that has tests. `engine.ts` is the thin wiring that plays it.
 *
 * Three rules the sound follows, all of them from the spec rather than taste:
 *
 * - **It carries no information.** Spec §5.2 asks a first-time viewer to
 *   understand the screen in five seconds *with the sound off*, so nothing here
 *   may be the only place something is said. It is air, not a channel.
 * - **It never announces money.** Spec §8.5 forbids a paid event buying screen
 *   dominance; it does not get to buy loudness either. Nothing in this file
 *   reads a paid effect, and the master level is fixed.
 * - **It is not a nursery.** Spec §5.3 rules out 유아용 어휘 and 동요, which in a
 *   soundtrack means no bright major-triad jingles. The scale set below is
 *   pentatonic and modal, and a crisis makes the room quieter rather than
 *   alarming (spec §6.3: the creature is never at risk).
 *
 * Everything is generated from oscillators at runtime. There is no audio file,
 * no sample, no third-party track — the same position `ASSETS.md` records for
 * every visual asset in this repository.
 */

/** Semitone offsets from the root, ascending. Pentatonic and modal only. */
export interface ScaleShape {
  readonly id: string
  readonly degrees: readonly number[]
}

/**
 * Six scales, none of them a major triad.
 *
 * `hirajoshi` and `insen` are Japanese pentatonic scales, which is the right
 * default for a broadcast whose primary language and time base are Japanese
 * (spec §5.3). The others are modal and equally free of the leading tone that
 * makes a phrase sound like a jingle resolving.
 */
export const SCALES: Readonly<Record<string, ScaleShape>> = Object.freeze({
  hirajoshi: { id: 'hirajoshi', degrees: [0, 2, 3, 7, 8] },
  insen: { id: 'insen', degrees: [0, 1, 5, 7, 10] },
  yo: { id: 'yo', degrees: [0, 2, 5, 7, 9] },
  dorian: { id: 'dorian', degrees: [0, 2, 3, 5, 7, 9, 10] },
  lydian: { id: 'lydian', degrees: [0, 2, 4, 6, 7, 9, 11] },
  aeolian: { id: 'aeolian', degrees: [0, 2, 3, 5, 7, 8, 10] },
})

const SCALE_FALLBACK = SCALES['hirajoshi'] as ScaleShape

/** The sound of one moment, in units `engine.ts` can apply directly. */
export interface AudioScore {
  /** Stable id for the combination, so a no-op re-render is recognisable. */
  readonly scoreId: string
  /** Drone root, Hz. */
  readonly rootHz: number
  readonly scale: ScaleShape
  /** Lowpass cutoff on the whole mix, Hz. Weather and phase open or close it. */
  readonly cutoffHz: number
  /** Seconds between one bell and the next. Longer is calmer. */
  readonly bellIntervalSec: number
  /** Peak gain of a single bell, before the master level. */
  readonly bellGain: number
  /** Steady gain of the drone, before the master level. */
  readonly droneGain: number
  /** Detune between the drone's two voices, cents. Wider beats slower. */
  readonly droneDetuneCents: number
}

/**
 * Master level, applied on top of everything above.
 *
 * Low on purpose. This plays under a stream a viewer did not ask for sound from,
 * and the spec's five-second test assumes they may have muted it entirely — so
 * the only failure that matters here is being loud, not being quiet.
 *
 * `provisional` (BOARD A-15): chosen by ear against the encoder, not measured to
 * a loudness target. A real LUFS measurement would replace it.
 */
export const MASTER_GAIN = 0.09

/** Time of day sets the root and how open the room is. */
const PHASE_VOICES: Readonly<
  Record<string, { readonly rootHz: number; readonly cutoffHz: number; readonly scale: string }>
> = Object.freeze({
  dawn: { rootHz: 174.61, cutoffHz: 1400, scale: 'yo' },
  morning: { rootHz: 196.0, cutoffHz: 2000, scale: 'yo' },
  day: { rootHz: 196.0, cutoffHz: 2400, scale: 'lydian' },
  afternoon: { rootHz: 185.0, cutoffHz: 2000, scale: 'dorian' },
  dusk: { rootHz: 164.81, cutoffHz: 1200, scale: 'hirajoshi' },
  night: { rootHz: 146.83, cutoffHz: 800, scale: 'insen' },
})

const PHASE_DEFAULT = { rootHz: 174.61, cutoffHz: 1500, scale: 'hirajoshi' } as const

/** Weather trims the top and the pace, the way it trims brightness and speed. */
const WEATHER_TRIM: Readonly<
  Record<string, { readonly cutoffScale: number; readonly intervalScale: number }>
> = Object.freeze({
  clear: { cutoffScale: 1.15, intervalScale: 0.9 },
  cloudy: { cutoffScale: 0.85, intervalScale: 1.1 },
  rain: { cutoffScale: 0.6, intervalScale: 1.25 },
  snow: { cutoffScale: 0.7, intervalScale: 1.4 },
  wind: { cutoffScale: 1.0, intervalScale: 0.85 },
})

const WEATHER_DEFAULT = { cutoffScale: 1, intervalScale: 1 } as const

/** Mood moves the bell rate, and nothing else — a mood is not a key change. */
const MOOD_INTERVAL_SCALE: Readonly<Record<string, number>> = Object.freeze({
  happy: 0.8,
  playful: 0.7,
  content: 1,
  sleepy: 1.6,
  hungry: 1.15,
  lonely: 1.3,
})

const BASE_BELL_INTERVAL_SEC = 6.5

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/**
 * Turns the world into a score.
 *
 * Pure: same conditions in, same score out, which is what lets `engine.ts` skip
 * work when nothing that matters has changed and what lets the tests below pin
 * the rules rather than the sound.
 */
export function scoreFor(conditions: SceneConditions): AudioScore {
  const phase = PHASE_VOICES[conditions.worldPhaseId] ?? PHASE_DEFAULT
  const weather = WEATHER_TRIM[conditions.weatherId] ?? WEATHER_DEFAULT
  const moodScale = MOOD_INTERVAL_SCALE[conditions.emotionId] ?? 1
  const scale = SCALES[phase.scale] ?? SCALE_FALLBACK

  // A crisis is quiet, not loud. Spec §6.3: the creature is never actually at
  // risk, so the room withdraws instead of alarming anyone.
  const restingCutoff = conditions.resting ? 0.55 : 1
  const restingGain = conditions.resting ? 0.6 : 1
  const restingInterval = conditions.resting ? 1.5 : 1

  const cutoffHz = clamp(phase.cutoffHz * weather.cutoffScale * restingCutoff, 220, 6000)
  const bellIntervalSec = clamp(
    BASE_BELL_INTERVAL_SEC * weather.intervalScale * moodScale * restingInterval,
    2.5,
    24,
  )

  return {
    scoreId: [
      conditions.worldPhaseId,
      conditions.weatherId,
      conditions.emotionId,
      conditions.resting ? 'resting' : 'awake',
    ].join(':'),
    rootHz: phase.rootHz,
    scale,
    cutoffHz,
    bellIntervalSec,
    bellGain: 0.16 * restingGain,
    droneGain: 0.32 * restingGain,
    droneDetuneCents: conditions.resting ? 5 : 9,
  }
}

/**
 * The next bell's pitch, in Hz.
 *
 * Seeded rather than random (CLAUDE.md §4): the same run replays the same
 * melody, so a soak or a replay is comparable and nothing here is a source of
 * nondeterminism. `step` is the bell's index since the run began.
 */
export function bellHz(score: AudioScore, step: number): number {
  // A small integer hash, so consecutive steps do not walk the scale in order
  // and the line does not sound like an exercise.
  const mixed = Math.imul(step + 1, 2654435761) >>> 0
  const degrees = score.scale.degrees
  const degree = degrees[mixed % degrees.length] ?? 0
  // Two octaves above the drone, occasionally three: bells sit clear of the pad.
  const octave = 2 + ((mixed >>> 8) % 2)
  return score.rootHz * Math.pow(2, octave + degree / 12)
}
