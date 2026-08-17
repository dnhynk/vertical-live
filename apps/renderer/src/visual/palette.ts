import type { WorldSnapshot } from '@vl/contract'

/**
 * Background and lighting variation by state, chapter and environment
 * (spec §12.5: the same command must not always produce the same scene).
 *
 * The world speaks in identifiers, so this is a lookup: time of day sets the
 * base, the place tints it, the weather changes how bright and how fast it
 * moves, the chapter sets the accent and the creature's mood trims the key
 * light. Every table has a documented default, because the content director
 * (T7) owns the vocabulary and may add a value before the renderer knows it —
 * an unknown identifier must look plain, never break the broadcast.
 *
 * All of it is a pure function of the snapshot: nothing is animated from local
 * state and nothing is random (the renderer owns no state, spec §10.2).
 */

export interface ScenePalette {
  /** Identifies the combination for tests and for the `?mode=dev` panel. */
  readonly paletteId: string
  readonly skyTop: string
  readonly skyMid: string
  readonly skyBottom: string
  readonly ambientColor: string
  readonly ambientIntensity: number
  readonly keyColor: string
  readonly keyIntensity: number
  readonly rimColor: string
  readonly rimIntensity: number
  /** HUD accent, driven by the chapter. */
  readonly accent: string
  /** Background animation speed multiplier. */
  readonly motion: number
}

export interface SceneConditions {
  readonly worldPhaseId: string
  readonly environmentId: string
  readonly weatherId: string
  readonly chapterId: string
  readonly emotionId: string
  /**
   * The creature is in a recoverable crisis (spec §6.3). The room goes quiet
   * rather than dark-and-alarming: nothing here says the creature is at risk,
   * because it never is (spec §6.3, §8.5).
   */
  readonly resting: boolean
}

interface PhaseTone {
  readonly skyTop: string
  readonly skyMid: string
  readonly skyBottom: string
  readonly keyColor: string
  readonly keyIntensity: number
  readonly ambientColor: string
  readonly ambientIntensity: number
}

const PHASE_DEFAULT: PhaseTone = {
  skyTop: '#1b2a3a',
  skyMid: '#2f4258',
  skyBottom: '#0f1720',
  keyColor: '#fdf6e3',
  keyIntensity: 1,
  ambientColor: '#c9d6e4',
  ambientIntensity: 0.55,
}

const PHASE_TONES: Readonly<Record<string, PhaseTone>> = {
  dawn: {
    skyTop: '#2b3f63',
    skyMid: '#8a6f8f',
    skyBottom: '#e0a887',
    keyColor: '#ffd0a6',
    keyIntensity: 0.95,
    ambientColor: '#a8b6d8',
    ambientIntensity: 0.5,
  },
  morning: {
    skyTop: '#6fb7e8',
    skyMid: '#a9dcf5',
    skyBottom: '#f3efd8',
    keyColor: '#fff6e0',
    keyIntensity: 1.25,
    ambientColor: '#d8e8f2',
    ambientIntensity: 0.7,
  },
  afternoon: {
    skyTop: '#3f97d8',
    skyMid: '#8fc9e8',
    skyBottom: '#f7e6bd',
    keyColor: '#fffaf0',
    keyIntensity: 1.35,
    ambientColor: '#e2ecf4',
    ambientIntensity: 0.75,
  },
  evening: {
    skyTop: '#3a2a52',
    skyMid: '#b4643f',
    skyBottom: '#f0a45f',
    keyColor: '#ffc487',
    keyIntensity: 1.05,
    ambientColor: '#b39ac0',
    ambientIntensity: 0.5,
  },
  night: {
    skyTop: '#0b1226',
    skyMid: '#1c2647',
    skyBottom: '#2e2a4a',
    keyColor: '#c9d8ff',
    // Night is the low end of the range, but the creature still has to read on
    // a phone at arm's length: dark is a mood here, not an absence of light.
    keyIntensity: 0.85,
    ambientColor: '#8fa0c8',
    ambientIntensity: 0.5,
  },
}

interface EnvironmentTint {
  /** Mixed into the lower sky, i.e. what surrounds the creature. */
  readonly ground: string
  readonly groundMix: number
  readonly rimColor: string
}

const ENVIRONMENT_DEFAULT: EnvironmentTint = {
  ground: '#2a2f36',
  groundMix: 0.2,
  rimColor: '#7dd3fc',
}

const ENVIRONMENT_TINTS: Readonly<Record<string, EnvironmentTint>> = {
  home_room: { ground: '#8a5c3b', groundMix: 0.4, rimColor: '#ffb877' },
  garden: { ground: '#4f7f43', groundMix: 0.42, rimColor: '#9be080' },
  riverside: { ground: '#2f6f8f', groundMix: 0.42, rimColor: '#7fd8ff' },
  night_terrace: { ground: '#3b3357', groundMix: 0.45, rimColor: '#c0a6ff' },
}

interface WeatherEffect {
  /** Multiplies every light intensity. */
  readonly light: number
  /** Multiplies the background animation speed. */
  readonly motion: number
  /** Mixed into the whole sky. */
  readonly wash: string
  readonly washMix: number
}

const WEATHER_DEFAULT: WeatherEffect = { light: 1, motion: 1, wash: '#ffffff', washMix: 0 }

const WEATHER_EFFECTS: Readonly<Record<string, WeatherEffect>> = {
  clear: { light: 1.05, motion: 1, wash: '#fff3c4', washMix: 0.06 },
  cloudy: { light: 0.82, motion: 0.75, wash: '#9aa4ad', washMix: 0.26 },
  rain: { light: 0.68, motion: 1.35, wash: '#5c7488', washMix: 0.34 },
  wind: { light: 0.95, motion: 1.8, wash: '#cfe3d8', washMix: 0.14 },
  starry: { light: 0.75, motion: 0.45, wash: '#26325c', washMix: 0.3 },
}

/** Chapter accent, used by the HUD rule and the rim light (spec §6.2 day scale). */
const CHAPTER_ACCENT_DEFAULT = '#ffd84d'

const CHAPTER_ACCENTS: Readonly<Record<string, string>> = {
  gathering: '#9be080',
  festival_prep: '#ff9f68',
  growth_choice: '#8fd0ff',
}

/** Mood trims the key light a little; it never changes what the screen says. */
const MOOD_KEY_SCALE_DEFAULT = 1

const MOOD_KEY_SCALES: Readonly<Record<string, number>> = {
  joyful: 1.12,
  content: 1,
  curious: 1.06,
  lonely: 0.9,
  sleepy: 0.85,
  weary: 0.82,
  worried: 0.88,
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function toHex(rgb: readonly [number, number, number]): string {
  const clamp = (channel: number): number => Math.max(0, Math.min(255, Math.round(channel)))
  return `#${clamp(rgb[0]).toString(16).padStart(2, '0')}${clamp(rgb[1])
    .toString(16)
    .padStart(2, '0')}${clamp(rgb[2]).toString(16).padStart(2, '0')}`
}

/** Linear mix; `ratio` 0 keeps `from`, 1 takes `to`. */
export function mixColors(from: string, to: string, ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const a = channels(from)
  const b = channels(to)
  return toHex([
    a[0] + (b[0] - a[0]) * clamped,
    a[1] + (b[1] - a[1]) * clamped,
    a[2] + (b[2] - a[2]) * clamped,
  ])
}

/** Reads the identifiers the scene varies on out of the authoritative snapshot. */
export function sceneConditions(snapshot: WorldSnapshot): SceneConditions {
  return {
    worldPhaseId: snapshot.environment.worldPhaseId,
    environmentId: snapshot.environment.environmentId,
    weatherId: snapshot.environment.weatherId,
    chapterId: snapshot.environment.chapterId,
    emotionId: snapshot.creature.emotionId,
    // The world reports a crisis by the key it puts in the fixed slot, which is
    // the only place the contract carries it (T7 `project.ts`).
    resting: snapshot.display.currentNeedOrMission.textKey.startsWith('crisis.'),
  }
}

export function selectPalette(conditions: SceneConditions): ScenePalette {
  const phase = PHASE_TONES[conditions.worldPhaseId] ?? PHASE_DEFAULT
  const environment = ENVIRONMENT_TINTS[conditions.environmentId] ?? ENVIRONMENT_DEFAULT
  const weather = WEATHER_EFFECTS[conditions.weatherId] ?? WEATHER_DEFAULT
  const accent = CHAPTER_ACCENTS[conditions.chapterId] ?? CHAPTER_ACCENT_DEFAULT
  const mood = MOOD_KEY_SCALES[conditions.emotionId] ?? MOOD_KEY_SCALE_DEFAULT
  const rest = conditions.resting ? 0.85 : 1

  const wash = (color: string): string => mixColors(color, weather.wash, weather.washMix)
  const light = weather.light * rest

  return {
    paletteId: [
      conditions.worldPhaseId,
      conditions.environmentId,
      conditions.weatherId,
      conditions.chapterId,
      conditions.resting ? 'rest' : conditions.emotionId,
    ].join('/'),
    skyTop: wash(phase.skyTop),
    skyMid: wash(phase.skyMid),
    skyBottom: wash(mixColors(phase.skyBottom, environment.ground, environment.groundMix)),
    ambientColor: phase.ambientColor,
    ambientIntensity: phase.ambientIntensity * light,
    keyColor: phase.keyColor,
    keyIntensity: phase.keyIntensity * light * mood,
    rimColor: environment.rimColor,
    rimIntensity: (conditions.resting ? 0.7 : 1.1) * weather.light,
    accent,
    motion: weather.motion * (conditions.resting ? 0.6 : 1),
  }
}

/** The palette drawn before the first snapshot arrives (spec §10.2: no guessing). */
export const WAITING_PALETTE: ScenePalette = selectPalette({
  worldPhaseId: '',
  environmentId: '',
  weatherId: '',
  chapterId: '',
  emotionId: '',
  resting: false,
})

/** The palette for the current snapshot, or the neutral one while waiting. */
export function paletteFor(snapshot: WorldSnapshot | null): ScenePalette {
  return snapshot === null ? WAITING_PALETTE : selectPalette(sceneConditions(snapshot))
}
