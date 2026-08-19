// Reads the renderer's own sources from disk; the browser build carries no node types.
/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * TASK_SPECS §T20c acceptance 1, as a static check over the whole workspace:
 * the paid staging — and every other component — cannot read `actor`.
 *
 * Spec §8.4 and §8.5 are the reason. A payment buys a fixed, anonymous thanks;
 * the moment a paid component could reach the consented viewer's name, spending
 * would buy a name on screen, which is the exact thing D-9 did **not** open. The
 * same applies to the mission beat, the ambience wash and the reaction chips:
 * D-9 opened one slot, so exactly one module may read the field, and everything
 * else receives an already-decided string or nothing at all.
 *
 * Checking the property name rather than the component list is what makes this
 * survive a new component: a file added next month that reads `effect.actor`
 * fails here without anyone remembering to add it to a list.
 */

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const RENDERER_ROOT = dirname(SRC)

const SCANNED_EXTENSIONS = /\.(ts|tsx|mjs)$/
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'public'])

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
 * Comments are stripped before scanning. Prose explaining why a component may
 * not touch `actor` is not a component touching `actor`, and the explanations
 * are the point of this codebase.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const FILES = collect(RENDERER_ROOT).map((path) => ({
  path: relative(RENDERER_ROOT, path).split(sep).join('/'),
  source: stripComments(readFileSync(path, 'utf8')),
}))

/**
 * The wire field, as it can only be spelled when it is being read: `.actor`,
 * `actor:`, `actor,`. The hyphen in the lookarounds keeps a class name or a
 * `data-testid` (`slot-actor`, `slot-last-action-actor`) out of the result, and
 * the word character keeps `actorName` — the already-decided string a component
 * may receive — out of it too. `SAMPLE_CONSENTED_ACTOR` is upper case and never
 * matches. What is left is reading identity, which is the thing being confined.
 */
const ACTOR_FIELD = /(?<![-\w])actor(?![-\w])/
const DISPLAY_NAME_FIELD = /(?<![-\w])displayName(?![-\w])/

/**
 * The one module D-9 allows to read the field, plus the files that *write* wire
 * data for tests and for the `?mode=dev` preview. `no-fabrication.test.ts`
 * already proves no application module imports the preview states, so nothing
 * that ships can reach the field through them.
 */
const MAY_READ_ACTOR = new Set([
  'src/read-model/identity.ts',
  'src/read-model/identity.test.ts',
  'src/read-model/identity-confinement.test.ts',
  'src/testing/preview-states.ts',
  'src/testing/preview-states.test.ts',
  'src/components/Screen.test.tsx',
])

describe('actor is confined to one module (spec §8.4, §8.5, BOARD D-9)', () => {
  it('scans the whole workspace, not a corner of it', () => {
    expect(FILES.length).toBeGreaterThan(25)
    expect(FILES.some((file) => file.path === 'src/read-model/identity.ts')).toBe(true)
    expect(FILES.some((file) => file.path === 'src/components/PaidThanks.tsx')).toBe(true)
  })

  it('is read nowhere but the selector that decides whether a name may be shown', () => {
    const readers = FILES.filter((file) => ACTOR_FIELD.test(file.source))
      .map((file) => file.path)
      .sort()
    expect(readers.filter((path) => !MAY_READ_ACTOR.has(path))).toEqual([])
    // The selector really is one of them: an empty result would pass the line
    // above while meaning the feature had been deleted.
    expect(readers).toContain('src/read-model/identity.ts')
  })

  it('keeps the display name out of every component, paid staging included', () => {
    const components = FILES.filter(
      (file) => file.path.startsWith('src/components/') && !file.path.includes('.test.'),
    )
    expect(components.length).toBeGreaterThan(8)
    const offenders = components
      .filter((file) => ACTOR_FIELD.test(file.source) || DISPLAY_NAME_FIELD.test(file.source))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })

  it('renders text, never markup: the shipped renderer has no HTML injection point', () => {
    // A test may *read* `container.innerHTML` to assert something is absent from
    // the DOM. What may not exist is a module that writes markup, because that
    // is the only way a name could stop being text (spec §12.3).
    const offenders = FILES.filter((file) => !file.path.includes('.test.'))
      .filter((file) =>
        /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(
          file.source,
        ),
      )
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })
})
