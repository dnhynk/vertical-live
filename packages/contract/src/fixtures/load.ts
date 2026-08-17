import { readFileSync, readdirSync } from 'node:fs'

/**
 * Node-only loader for the source fixtures in `packages/contract/fixtures/`.
 *
 * Exposed as the `@vl/contract/fixtures` entry point so the server tests (T9)
 * and the simulator (T11) can replay the same items the contract tests use,
 * without pulling `node:fs` into the renderer bundle.
 *
 * Every fixture is a synthetic item: ids, gift names and text are obviously
 * fabricated test values, never captured real chat (spec §2.6).
 */

export type FixtureShape = 'grpc' | 'rest'

export interface SourceFixture {
  readonly shape: FixtureShape
  /** File name without the `.json` suffix, e.g. `gift-event-combo-3`. */
  readonly name: string
  /** The raw API item, exactly as the platform would deliver it. */
  readonly item: unknown
}

export const FIXTURES_DIR_URL = new URL('../../fixtures/', import.meta.url)

function fixtureFileUrl(shape: FixtureShape, name: string): URL {
  return new URL(`${shape}/${name}.json`, FIXTURES_DIR_URL)
}

/** Fixture names available for a shape, sorted for deterministic test output. */
export function listSourceFixtureNames(shape: FixtureShape): string[] {
  return readdirSync(new URL(`${shape}/`, FIXTURES_DIR_URL))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort()
}

export function loadSourceFixture(shape: FixtureShape, name: string): SourceFixture {
  const raw = readFileSync(fixtureFileUrl(shape, name), 'utf8')
  return { shape, name, item: JSON.parse(raw) as unknown }
}

export function loadSourceFixtures(shape: FixtureShape): SourceFixture[] {
  return listSourceFixtureNames(shape).map((name) => loadSourceFixture(shape, name))
}
