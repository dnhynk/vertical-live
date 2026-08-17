import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SUPERVISOR_STATES } from '@vl/server/supervisor'
import { describe, expect, it } from 'vitest'

import { FAULT_MATRIX_DOC_PATH, renderFaultMatrixDoc } from './doc.js'
import { FAULT_MATRIX } from './rows.js'

/**
 * The checked-in document is a build product of `rows.ts` (CLAUDE.md §4).
 *
 * This is what makes "실행 전에 고정" true rather than aspirational: the table an
 * operator reads and the expectations `matrix.test.ts` asserts are the same
 * object, and a row edited in one place without regenerating the other fails
 * here instead of quietly diverging.
 */

const DOC_PATH = fileURLToPath(new URL(`../../../../${FAULT_MATRIX_DOC_PATH}`, import.meta.url))

describe('fault matrix rows', () => {
  it('covers every fault spec §11 names', () => {
    const faults = FAULT_MATRIX.map((row) => row.fault).join(' | ')
    for (const required of [
      'OAuth access-token 만료',
      'OAuth refresh-token 철회',
      '403',
      '429',
      'quota 고갈',
      'DNS 단절',
      'RTMPS 단절',
      'DB lock',
      'disk-full',
      'WebGL context loss',
      'OBS process crash',
      'host crash',
      'inbox commit',
      'token checkpoint',
      'state commit',
      'effect 발행',
    ]) {
      expect(faults).toContain(required)
    }
  })

  it('has unique ids and a complete, fixed expectation on every row', () => {
    const ids = FAULT_MATRIX.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const row of FAULT_MATRIX) {
      expect(row.injection.length).toBeGreaterThan(0)
      expect(row.dataPreservation.length).toBeGreaterThan(0)
      expect(row.spec).toMatch(/§/)
      expect(['retry', 'degraded', 'safe_stopped']).toContain(row.expected)
      expect(SUPERVISOR_STATES).toContain(row.expectedState)
    }
  })

  it('never leaves a `safe_stopped` row expecting a state the run can leave', () => {
    for (const row of FAULT_MATRIX) {
      if (row.expected !== 'safe_stopped') continue
      expect(row.expectedState).toBe('safe_stopped')
    }
  })
})

describe('docs/ops/fault-matrix.md', () => {
  it('is exactly what the generator produces', () => {
    expect(readFileSync(DOC_PATH, 'utf8')).toBe(renderFaultMatrixDoc())
  })

  it('lists every row', () => {
    const document = renderFaultMatrixDoc()
    for (const row of FAULT_MATRIX) {
      expect(document).toContain(`| ${row.id} |`)
      expect(document).toContain(`### ${row.id} — ${row.fault}`)
    }
  })
})
