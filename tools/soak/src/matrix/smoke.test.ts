import { afterEach, describe, expect, it } from 'vitest'

import type { SoakSystem } from '../system.js'
import { startLive, tick } from './support.js'

/**
 * The scaffolding itself, before any fault is injected.
 *
 * A matrix drill that started from a system which was never healthy would prove
 * nothing about the fault, so this pins the baseline: the §7.3(3) start-up
 * sequence runs, the pre-checks pass, every required §9.4 family reports `ok`
 * and the world keeps committing with no input at all (spec §2.1).
 */

let system: SoakSystem | undefined

afterEach(async () => {
  await system?.close()
  system = undefined
})

describe('soak system baseline', () => {
  it('reaches live through the production start-up sequence and pre-checks', async () => {
    const drill = await startLive()
    system = drill.system

    expect(system.supervisor.state).toBe('live')
    expect(system.supervisor.health().preflight.every((check) => check.passed)).toBe(true)
    expect(system.supervisor.aggregate?.requiredNotOk).toEqual([])
    expect(system.supervisor.health().interactionEnabled).toBe(true)
  })

  it('keeps the world progressing with no viewer input at all (spec §2.1)', async () => {
    const drill = await startLive()
    system = drill.system
    const before = system.observe().stateRevision

    await tick(system, 30)

    expect(system.observe().stateRevision).toBeGreaterThan(before)
    expect(system.supervisor.state).toBe('live')
  })

  it('accepts synthetic commands over the real ingest endpoint and drains them', async () => {
    const drill = await startLive()
    system = drill.system

    const inserted = await system.inject(3)
    await tick(system, 2)

    expect(inserted).toBe(3)
    expect(system.observe().processedIngestSeq).toBe(3)
  })
})
