import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { loadRetentionConfig } from './config.js'
import {
  BEGIN_MARKER,
  DATA_MAP_URL,
  DataMapMarkerError,
  END_MARKER,
  extractDataMap,
  renderDataMap,
  spliceDataMap,
} from './data-map.js'

/**
 * `docs/ops/data-map.md` is the field-level table TASK_SPECS §T13 asks for. Its
 * tables are generated from `config/retention.json`, so this test is the CI-side
 * freshness gate (same arrangement as the contract's JSON Schema registry).
 */

const document = readFileSync(fileURLToPath(DATA_MAP_URL), 'utf8')
const config = loadRetentionConfig()

describe('docs/ops/data-map.md', () => {
  it('is up to date with config/retention.json', () => {
    // Fails when the config changed without regenerating the document. Fix:
    // `npm run data-map:generate -w @vl/server`.
    expect(extractDataMap(document)).toBe(renderDataMap(config))
  })

  it('lists every field, its purpose and its schedule', () => {
    const region = extractDataMap(document)
    for (const field of config.fields) {
      expect(region).toContain(`\`${field.key}\``)
      expect(region).toContain(field.purpose.replaceAll('|', '\\|'))
      expect(region).toContain(field.personalIdentifiers)
    }
    for (const entry of config.schemaOnlyTables) {
      expect(region).toContain(`\`${entry.table}\``)
    }
  })

  it('states both revocation windows', () => {
    const region = extractDataMap(document)
    expect(region).toContain('`consent_revoked` | 7 days')
    expect(region).toContain('`provider_revoked` | 30 days')
    expect(region).toContain('`user_request` | 7 days')
  })

  it('keeps the hand-written prose outside the generated region', () => {
    const before = document.slice(0, document.indexOf(BEGIN_MARKER))
    expect(before).toContain('스펙 §12.4')
    expect(document.slice(document.indexOf(END_MARKER))).toContain('Gate 2')
  })

  it('refuses to splice a document with no markers', () => {
    expect(() => spliceDataMap('# no markers here', 'x')).toThrow(DataMapMarkerError)
    expect(() => extractDataMap('# no markers here')).toThrow(DataMapMarkerError)
  })
})
