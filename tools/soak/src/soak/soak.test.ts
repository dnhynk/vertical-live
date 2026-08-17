import { describe, expect, it } from 'vitest'

import { loadSoakConfig } from '../config.js'
import { formatSoakReport } from './report.js'
import { RECOVERABLE_FAULTS, runSoak, SoakConfigurationError } from './run.js'

/**
 * The accelerated soak, as CI runs it (TASK_SPECS §T15 합격 기준 2).
 *
 * `npm run soak:ci` runs the configured 72 hours of scenario time; this test
 * runs a compressed slice of the same harness so `npm run test` proves the
 * report is produced and the invariants hold, without spending the full CI
 * budget twice. Both go through `runSoak`, so what is asserted here is what the
 * long run does.
 */

const SHORT_RUN = { durationMs: 2 * 60 * 60 * 1000, sliceMs: 5_000, faultIntervalMs: 900_000 }

describe('accelerated soak', () => {
  it('runs the fault schedule and reports a passing run', async () => {
    const report = await runSoak({
      mode: 'accelerated',
      shape: SHORT_RUN,
      restartDelayMs: 500,
    })

    expect(report.mode).toBe('accelerated')
    expect(report.clock).toBe('virtual')
    expect(report.finalState).toBe('live')
    expect(report.counters.slices).toBeGreaterThan(100)
    expect(report.counters.faultsInjected.length).toBeGreaterThan(0)
    // Every injected fault is a matrix row, so a report names what it drilled.
    for (const injected of report.counters.faultsInjected) {
      expect(RECOVERABLE_FAULTS.some((fault) => injected.startsWith(`${fault.row}:`))).toBe(true)
    }

    // The invariants of spec §2/§9.2/§11 — the part that needs no approved number.
    for (const invariant of report.invariants) {
      expect(invariant.held, `${invariant.name}: ${invariant.detail}`).toBe(true)
    }
    expect(report.passed).toBe(true)
  }, 240_000)

  it('recovers from every interruption it caused', async () => {
    const report = await runSoak({
      mode: 'accelerated',
      shape: SHORT_RUN,
      restartDelayMs: 500,
    })

    expect(report.counters.interruptions).toBeGreaterThan(0)
    expect(report.counters.unrecoveredInterruptions).toBe(0)
    expect(report.counters.recoveries).toBe(report.counters.interruptions)
    expect(report.maxContinuousOutageMs).toBeGreaterThan(0)
  }, 240_000)

  it('reports the Gate 0/2 thresholds as not locked rather than inventing them', async () => {
    const config = loadSoakConfig()
    const report = await runSoak({
      mode: 'accelerated',
      shape: { ...SHORT_RUN, durationMs: 30 * 60 * 1000 },
      restartDelayMs: 500,
    })

    // BOARD A-15: nothing in this repository may fill in a §11 pass line.
    expect(Object.values(config.thresholds).every((value) => value === null)).toBe(true)
    expect(report.thresholds.every((threshold) => threshold.outcome !== 'exceeded')).toBe(true)
    expect(report.thresholds.some((threshold) => threshold.outcome === 'not-locked')).toBe(true)

    const text = formatSoakReport(report)
    expect(text).toContain('not-locked')
    expect(text).toContain('BOARD A-15')
    expect(text).toContain('WARNING: under the virtual clock')
  }, 240_000)

  it('refuses a slice coarser than the coordinator heartbeat window', async () => {
    await expect(
      runSoak({ mode: 'accelerated', shape: { ...SHORT_RUN, sliceMs: 60_000 } }),
    ).rejects.toBeInstanceOf(SoakConfigurationError)
  })
})
