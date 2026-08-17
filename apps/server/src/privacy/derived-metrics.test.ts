import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  APPROVAL_GATED_METRICS,
  FORBIDDEN_METRIC_TOKENS,
  findForbiddenMetricTokens,
  normalizeForMetricScan,
} from './derived-metrics.js'
import { createRetentionHarness, type RetentionHarness } from './testing/harness.js'

/**
 * TASK_SPECS §T13: "승인 전 후보 지표(§14.1의 '승인 후 후보')를 계산·저장하는 코드가
 * 없음을 테스트로 고정" (spec §12.4 last paragraph, §14.1, [S42]).
 *
 * The proof is a scan of every workspace source file plus the live SQL schema. The
 * registry module and this test are excluded — they must name the metrics in order
 * to forbid them; everything else must not name them at all.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** Workspace source trees plus the shared config and tooling (CLAUDE.md §5). */
const SCANNED_ROOTS = ['apps', 'packages', 'tools', 'config', 'scripts', 'ops']

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'legacy', 'coverage'])

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sql']

/** The two files that are allowed to name the gated metrics. */
const REGISTRY_FILES = ['derived-metrics.ts', 'derived-metrics.test.ts']

function sourceFiles(directory: string): string[] {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path)
    }
    if (REGISTRY_FILES.includes(entry.name)) return []
    return SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : []
  })
}

const FILES = SCANNED_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)))

let harness: RetentionHarness | undefined

afterEach(() => {
  harness?.dispose()
  harness = undefined
})

describe('approval-gated derived metrics', () => {
  it('lists every §14.1 "승인 후 후보" row with its gate', () => {
    const axes = APPROVAL_GATED_METRICS.map((metric) => metric.axis)
    expect(axes).toEqual(['참여', '반복 참여', '수익', '수익 건전성', '안전'])
    for (const metric of APPROVAL_GATED_METRICS) {
      expect(metric.forbiddenTokens.length).toBeGreaterThan(0)
      expect(metric.specRef).toMatch(/§14/)
      for (const token of metric.forbiddenTokens) {
        // Tokens are matched against normalized text, so they must already be in
        // normalized form or they could never match anything.
        expect(normalizeForMetricScan(token)).toBe(token)
      }
    }
    expect(FORBIDDEN_METRIC_TOKENS.size).toBeGreaterThan(20)
  })

  it('detects a gated metric when one is present (scanner control)', () => {
    // Without this the scan below could pass by simply never matching anything.
    const hits = findForbiddenMetricTokens('const uniqueAuthorsPer1000EngagedViews = 0')
    expect(hits.map((hit) => hit.token)).toContain('uniqueauthors')
    expect(hits.map((hit) => hit.metricId)).toContain('unique_authors_per_1000_engaged_views')
    expect(findForbiddenMetricTokens('const per_1000_chats = 0')[0]?.token).toBe('per1000chats')
    expect(findForbiddenMetricTokens('const acceptedCommands = 0')).toEqual([])
  })

  it('scans a non-trivial number of workspace files', () => {
    expect(FILES.length).toBeGreaterThan(60)
    expect(FILES.some((file) => file.endsWith('retention.json'))).toBe(true)
    expect(FILES.some((file) => file.endsWith('001_initial.sql'))).toBe(true)
  })

  it('no workspace source computes or stores one of them', () => {
    const offenders = FILES.flatMap((file) => {
      const hits = findForbiddenMetricTokens(readFileSync(file, 'utf8'))
      return hits.map((hit) => `${file.slice(REPO_ROOT.length)}: ${hit.token} (${hit.metricId})`)
    })
    expect(offenders).toEqual([])
  })

  it('no table, column or index in the schema stores one of them', () => {
    harness = createRetentionHarness()
    const store = harness.store
    const targets = store
      .listTables()
      .flatMap((table) => [table, ...store.listColumns(table).map((column) => `${table}.${column}`)])
    expect(targets.length).toBeGreaterThan(50)

    const offenders = targets.filter((target) => findForbiddenMetricTokens(target).length > 0)
    expect(offenders).toEqual([])
    const schemaOffenders = store
      .listSchemaDefinitions()
      .filter((definition) => findForbiddenMetricTokens(definition.sql).length > 0)
      .map((definition) => definition.name)
    expect(schemaOffenders).toEqual([])
  })
})
