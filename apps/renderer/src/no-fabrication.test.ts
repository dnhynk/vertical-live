// The renderer compiles without Node types on purpose (browser code). This one
// test reads the sources from disk, so it asks for them locally.
/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * TASK_SPECS §T5 acceptance 4 and the CLAUDE.md §3 invariants, checked over the
 * renderer sources themselves:
 *
 * 1. no identity field can be read, stored or displayed (spec §7.3(1), §12.3),
 * 2. no browser storage, so a refresh recovers from the server snapshot alone
 *    (spec §10.2),
 * 3. randomness exists only as an injected seam, so nothing can invent a value,
 * 4. the synthetic fixtures cannot reach the broadcast bundle: no application
 *    module imports them (spec §2.6 "no fake participation").
 */

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)))

function collect(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      collect(path, found)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry.name)) found.push(path)
  }
  return found
}

/**
 * Comments are stripped before scanning: prose that names a forbidden field in
 * order to say it is absent is not an occurrence of it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * The static checkers carry the forbidden patterns in their own code, so they
 * are excluded from the scan. `paid-staging.test.ts` (TASK_SPECS §T14 acceptance
 * 3) names the identity and payment fields it forbids the paid staging from
 * mentioning, which is the same list this file scans for.
 */
const CHECKERS = new Set(['no-fabrication.test.ts', 'components/paid-staging.test.ts'])

const FILES = collect(SOURCE_ROOT)
  .map((path) => ({
    path: relative(SOURCE_ROOT, path).split(sep).join('/'),
    source: stripComments(readFileSync(path, 'utf8')),
  }))
  .filter((file) => !CHECKERS.has(file.path))

const APPLICATION_FILES = FILES.filter(
  (file) => !file.path.includes('.test.') && !file.path.startsWith('testing/'),
)

function offenders(files: readonly { path: string; source: string }[], pattern: RegExp): string[] {
  return files
    .filter((file) => pattern.test(file.source))
    .map((file) => file.path)
    .sort()
}

describe('renderer source invariants', () => {
  it('has no identity field anywhere', () => {
    expect(FILES.length).toBeGreaterThan(10)
    expect(
      offenders(FILES, /author|display_?name|channel_?id|user_?name|nick_?name|profile_?image/i),
    ).toEqual([])
  })

  it('never displays raw chat or accepts free text from the wire', () => {
    // The contract has no field carrying a chat line; these are the names the
    // adapters drop (spec §7.3(1)), so their absence is checked here too.
    expect(offenders(FILES, /message_?text|displayMessage|rawText|commandText/i)).toEqual([])
  })

  it('keeps no state in the browser', () => {
    expect(
      offenders(APPLICATION_FILES, /localStorage|sessionStorage|indexedDB|document\.cookie/),
    ).toEqual([])
  })

  it('only uses randomness through the injected reconnect-jitter seam', () => {
    expect(offenders(APPLICATION_FILES, /Math\.random/)).toEqual(['read-model/connection.ts'])
    expect(offenders(APPLICATION_FILES, /crypto\.randomUUID/)).toEqual(['config.ts'])
  })

  it('keeps the synthetic fixtures out of the application', () => {
    // The whole `testing/` directory, so the preview states T14 added cannot
    // reach the broadcast bundle either (spec §2.6).
    expect(offenders(APPLICATION_FILES, /testing\//)).toEqual([])
  })

  it('marks every fixture value as synthetic', () => {
    const fixtures = FILES.find((file) => file.path === 'testing/fixtures.ts')
    expect(fixtures).toBeDefined()
    const identifiers = [...(fixtures?.source.matchAll(/'([a-z][a-z0-9._-]{2,})'/g) ?? [])]
      .map((match) => match[1] as string)
      .filter((value) => value.includes('-') || value.includes('.'))
      .filter((value) => !value.startsWith('@vl/'))
    expect(identifiers.length).toBeGreaterThan(5)
    for (const identifier of identifiers) {
      expect(identifier.startsWith('sample')).toBe(true)
    }
  })
})
