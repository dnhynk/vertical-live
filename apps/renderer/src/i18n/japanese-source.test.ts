// This test reads the renderer's own sources from disk, so it asks for the node
// types the browser build deliberately does without.
/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { JA_ENTRIES, JA_NATIVE_REVIEW } from './index'

/**
 * TASK_SPECS §T14 acceptance 2, as a check over the sources:
 *
 * 1. every entry of `ja.json` carries `nativeReview: "pending"` (spec §5.3,
 *    BOARD A-11) — no wording may claim native review before Gate 3;
 * 2. there is no hard-coded Japanese string anywhere in the renderer. `ja.json`
 *    is the only file that may contain Japanese characters, so every sentence on
 *    the broadcast is reviewable in one place and translatable in one place.
 *
 * The §7.1 command aliases are the one other source of Japanese on screen, and
 * they arrive from `@vl/contract`'s alias table — data the spec itself fixes —
 * not from a literal in this workspace.
 */

const RENDERER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Hiragana, katakana (including the small-kana extension and the halfwidth
 * forms) and CJK ideographs, as code-point ranges rather than as a pattern
 * written in the characters themselves — this file needs no exception from its
 * own rule that way.
 */
const JAPANESE_RANGES: readonly (readonly [number, number])[] = [
  [0x3040, 0x30ff],
  [0x31f0, 0x31ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xff66, 0xff9d],
]

function hasJapanese(source: string): boolean {
  for (const character of source) {
    const codePoint = character.codePointAt(0) ?? 0
    if (JAPANESE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)) return true
  }
  return false
}

const SCANNED_EXTENSIONS = /\.(ts|tsx|css|html|mjs|json)$/
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'public'])

/** The resource itself is the only file allowed to carry Japanese. */
const ALLOWED = new Set(['src/i18n/ja.json'])

function collect(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) collect(join(directory, entry.name), found)
      continue
    }
    if (SCANNED_EXTENSIONS.test(entry.name)) found.push(join(directory, entry.name))
  }
  return found
}

/**
 * Comments are stripped before scanning: prose that names a Japanese phrase in
 * order to explain it is not a string the screen can print. What remains is code
 * and JSX text, which is what would reach a viewer.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const FILES = collect(RENDERER_ROOT).map((path) => ({
  path: relative(RENDERER_ROOT, path).split(sep).join('/'),
  source: readFileSync(path, 'utf8'),
}))

describe('ja.json (spec §5.3, BOARD A-11)', () => {
  it('is marked as awaiting native review, entry by entry', () => {
    const keys = Object.keys(JA_ENTRIES)
    expect(keys.length).toBeGreaterThan(40)
    expect(JA_NATIVE_REVIEW).toBe('pending')

    const reviewed = keys.filter((key) => JA_ENTRIES[key]?.nativeReview !== 'pending')
    expect(reviewed).toEqual([])
  })

  it('has wording for every key and an ASCII short alias where it has one', () => {
    for (const [key, entry] of Object.entries(JA_ENTRIES)) {
      expect(entry.text.length, key).toBeGreaterThan(0)
      if (entry.en !== undefined) expect(entry.en, key).toMatch(/^[A-Z0-9 '-]+$/)
    }
  })

  it('covers the content vocabulary the world can send (T7)', () => {
    const expected = [
      ...['hungry', 'play', 'affection', 'rest'].map((id) => `need.${id}`),
      ...['sleeping', 'tired', 'needs_help'].map((id) => `crisis.${id}`),
      ...[
        'share_a_meal',
        'chase_the_ribbon',
        'quiet_company',
        'gather_ingredients',
        'hang_the_lanterns',
      ].map((id) => `mission.${id}`),
      ...['gathering', 'festival_prep', 'growth_choice'].map((id) => `chapter.${id}`),
      ...['egg', 'hatchling', 'fledgling', 'companion', 'guardian'].map((id) => `stage.${id}`),
      'choice.gathering.forage_garden',
      'choice.gathering.river_walk',
      'choice.gathering.rest_indoors',
      'choice.festival_prep.lantern_row',
      'choice.festival_prep.music_practice',
      'choice.festival_prep.night_stalls',
      'choice.growth_choice.grow_swift',
      'choice.growth_choice.grow_gentle',
      'choice.growth_choice.grow_curious',
    ]
    expect(expected.filter((key) => JA_ENTRIES[key] === undefined)).toEqual([])
  })

  it('states that free participation reaches everything (spec §8.5)', () => {
    const note = JA_ENTRIES['ui.cta.freeNote']
    expect(note).toBeDefined()
    expect(note?.en).toContain('FREE')
    // Guilt and pressure copy is forbidden (spec §8.5, §5.3): the note is the
    // only place the screen talks about money at all, and it says it is optional.
    expect(note?.text.length).toBeGreaterThan(0)
  })
})

describe('renderer sources', () => {
  it('scans the whole workspace, not a corner of it', () => {
    expect(FILES.length).toBeGreaterThan(25)
    expect(FILES.some((file) => file.path === 'src/i18n/ja.json')).toBe(true)
    expect(FILES.some((file) => file.path === 'index.html')).toBe(true)
  })

  it('contains no hard-coded Japanese outside ja.json', () => {
    const offenders = FILES.filter((file) => !ALLOWED.has(file.path))
      .filter((file) => hasJapanese(stripComments(file.source)))
      .map((file) => file.path)
      .sort()
    expect(offenders).toEqual([])
  })
})
