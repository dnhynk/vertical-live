#!/usr/bin/env node
/**
 * Writes `packages/contract/schema/*.json` from the zod schemas.
 *
 *   npm run schema:generate -w @vl/contract   # build + write
 *   node scripts/generate-schema.mjs --check  # exit 1 when a file is stale
 *
 * Generated output is never edited by hand (CLAUDE.md §4). The freshness check
 * that runs in CI lives in `src/schema/registry.test.ts` so it is covered by
 * `npm run test`; `--check` is the same assertion for local use.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  SCHEMA_DIR_URL,
  SCHEMA_DOCUMENTS,
  serializeSchemaDocument,
} from '../dist/schema/registry.js'

const checkOnly = process.argv.includes('--check')
const schemaDir = fileURLToPath(SCHEMA_DIR_URL)

if (!checkOnly) mkdirSync(schemaDir, { recursive: true })

const stale = []
for (const document of SCHEMA_DOCUMENTS) {
  const target = fileURLToPath(new URL(document.fileName, SCHEMA_DIR_URL))
  const expected = serializeSchemaDocument(document)
  if (checkOnly) {
    let actual = null
    try {
      actual = readFileSync(target, 'utf8')
    } catch {
      actual = null
    }
    if (actual !== expected) stale.push(document.fileName)
  } else {
    writeFileSync(target, expected)
    process.stdout.write(`wrote schema/${document.fileName}\n`)
  }
}

if (checkOnly) {
  if (stale.length > 0) {
    process.stderr.write(
      `stale JSON Schema files: ${stale.join(', ')}\n` +
        'run `npm run schema:generate -w @vl/contract` and commit the result\n',
    )
    process.exit(1)
  }
  process.stdout.write(`schema up to date (${SCHEMA_DOCUMENTS.length} files)\n`)
}
