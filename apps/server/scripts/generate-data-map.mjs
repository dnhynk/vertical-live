#!/usr/bin/env node
/**
 * Writes the generated tables of `docs/ops/data-map.md` from `config/retention.json`.
 *
 *   npm run data-map:generate -w @vl/server    # build + write
 *   node scripts/generate-data-map.mjs --check # exit 1 when the file is stale
 *
 * Generated output is never edited by hand (CLAUDE.md §4). The freshness check
 * that runs in CI lives in `src/privacy/data-map.test.ts` so `npm run test` covers
 * it; `--check` is the same assertion for the build and for local use.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadRetentionConfig } from '../dist/privacy/config.js'
import {
  DATA_MAP_URL,
  extractDataMap,
  renderDataMap,
  spliceDataMap,
} from '../dist/privacy/data-map.js'

const checkOnly = process.argv.includes('--check')
const target = fileURLToPath(DATA_MAP_URL)
const document = readFileSync(target, 'utf8')
const region = renderDataMap(loadRetentionConfig())

if (checkOnly) {
  if (extractDataMap(document) !== region) {
    process.stderr.write(
      'docs/ops/data-map.md is stale\nrun `npm run data-map:generate -w @vl/server` and commit the result\n',
    )
    process.exit(1)
  }
  process.stdout.write('docs/ops/data-map.md up to date\n')
} else {
  const next = spliceDataMap(document, region)
  if (next === document) {
    process.stdout.write('docs/ops/data-map.md unchanged\n')
  } else {
    writeFileSync(target, next)
    process.stdout.write('wrote docs/ops/data-map.md\n')
  }
}
