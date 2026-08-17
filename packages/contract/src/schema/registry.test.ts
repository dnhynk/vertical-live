import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SCHEMA_DIR_URL, SCHEMA_DOCUMENTS, serializeSchemaDocument } from './registry.js'

/**
 * TASK_SPECS §T1 acceptance 3: the JSON Schema files are generated from the zod
 * schemas and CI checks that they are current.
 *
 * This test is the CI check. `npm run test` runs it, so a schema change that is
 * not followed by `npm run schema:generate -w @vl/contract` fails the gate
 * instead of shipping a stale contract to the other workspaces.
 */

const EXPECTED_FILES = [
  'canonical-event.schema.json',
  'effect.schema.json',
  'ingest-envelope.schema.json',
  'world-snapshot.schema.json',
  'ws-renderer-message.schema.json',
  'ws-server-message.schema.json',
]

describe('generated JSON Schema', () => {
  it('exports one document per contract type named in §T1', () => {
    expect(SCHEMA_DOCUMENTS.map((doc) => doc.fileName).sort()).toEqual(EXPECTED_FILES)
  })

  it('has no orphaned file left behind by a rename', () => {
    const onDisk = readdirSync(fileURLToPath(SCHEMA_DIR_URL))
      .filter((file) => file.endsWith('.json'))
      .sort()
    expect(onDisk).toEqual(EXPECTED_FILES)
  })

  it.each(SCHEMA_DOCUMENTS)('$fileName is byte-for-byte up to date', (document) => {
    const target = fileURLToPath(new URL(document.fileName, SCHEMA_DIR_URL))
    const committed = readFileSync(target, 'utf8')
    expect(
      committed,
      `${document.fileName} is stale — run \`npm run schema:generate -w @vl/contract\` and commit the result`,
    ).toBe(serializeSchemaDocument(document))
  })

  it.each(SCHEMA_DOCUMENTS)('$fileName declares draft 2020-12 and a versioned $id', (document) => {
    expect(document.document.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(document.document.$id).toMatch(/^urn:vl:contract:v1:[a-z-]+$/)
    expect(document.document.title).toBeTruthy()
  })
})
