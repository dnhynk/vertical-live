import { afterEach, describe, expect, it } from 'vitest'

import { findBuiltinScenario, type Scenario } from '../scenario/index.js'
import { buildAdversarialScenario } from '../runner/adversarial.js'
import { openSession, type SimulatorSession } from '../runner/session.js'
import { toMillis } from './support.js'

/**
 * Every scenario of TASK_SPECS §T11 played end to end against a real backend
 * over real HTTP, on the virtual clock (acceptance 1: "가상 시계 사용, 실시간
 * 대기 없음").
 *
 * The three §11 rows the task names — 유료 무결성, 모더레이션 우회 0, 재시작 후
 * 미처리 `ingestSeq` 복구 — have their own files. This one asserts that each
 * scenario does what its name says: the world advances with no input, the input
 * mode switches and switches back, a flood is absorbed, a degraded window holds
 * events instead of losing them.
 */

let session: SimulatorSession | null = null

afterEach(async () => {
  await session?.close()
  session = null
})

async function play(scenario: Scenario, sliceMs?: number): Promise<SimulatorSession> {
  session = await openSession(sliceMs === undefined ? {} : { sliceMs })
  return session
}

function requireScenario(id: string): Scenario {
  const scenario = findBuiltinScenario(id)
  if (scenario === null) throw new Error(`missing built-in scenario ${id}`)
  return scenario
}

describe('idle-24h', () => {
  it('advances content, state and world time for 24 virtual hours with zero input', async () => {
    const active = await play(requireScenario('idle-24h'), 5 * 60_000)
    const before = active.harness.engine.health()

    const result = await active.run(requireScenario('idle-24h'))
    const after = active.harness.engine.health()
    const snapshot = active.harness.engine.snapshot()

    expect(result.envelopesPosted).toBe(0)
    expect(result.scenarioMs).toBe(24 * 60 * 60 * 1000)
    // Spec §2.1: content, state and narrative advance with zero viewers.
    expect(after.stateRevision).toBeGreaterThan(before.stateRevision + 100)
    expect(toMillis(snapshot.worldTimeUtc) - toMillis(active.clock?.nowUtcIso() ?? '')).toBe(0)
    // A writer that wedged would show up here rather than as a silent zero.
    expect(after.lastFailure).toBeNull()
    expect(after.consecutiveFailures).toBe(0)
    expect(after.processedIngestSeq).toBe(0)
    // The renderer saw the world move, which is the point of the idle path.
    expect((active.renderer?.effectStarts ?? 0) > 0).toBe(true)
  }, 180_000)
})

describe('direct-low', () => {
  it('applies every free command individually and records the rejected items', async () => {
    const active = await play(requireScenario('direct-low'))

    const result = await active.run(requireScenario('direct-low'))
    const counters = active.harness.engine.metrics().counters
    const health = active.harness.engine.health()

    expect(result.refusals).toEqual([])
    expect(result.envelopesPosted).toBe(8)
    expect(result.inserted).toBe(8)
    expect(counters['command_direct']).toBe(6)
    expect(counters['command_aggregated'] ?? 0).toBe(0)
    // Spec §7.3(3): an unsupported or malformed envelope advances with a reason.
    expect(counters['envelope_unsupported']).toBe(1)
    expect(counters['envelope_invalid']).toBe(1)
    expect(health.inputMode).toBe('direct')
    // The cursor reached the end: nothing is left below it (spec §7.3(3)).
    expect(health.processedIngestSeq).toBe(8)
  }, 60_000)
})

describe('aggregate-switch', () => {
  it('switches to aggregate on a burst and back to direct on a quiet window', async () => {
    const active = await play(requireScenario('aggregate-switch'))

    await active.run(requireScenario('aggregate-switch'))
    const modes = (active.renderer?.snapshots ?? []).map((snapshot) => snapshot.inputMode)
    const counters = active.harness.engine.metrics().counters
    const health = active.harness.engine.health()

    expect(modes).toContain('aggregate')
    // Spec §6.4: the flood cap holds even inside a direct window.
    expect(counters['command_direct']).toBe(active.harness.inputConfig.window.maxDirectPerWindow)
    expect(counters['command_aggregated']).toBeGreaterThan(0)
    expect(counters['aggregate_window_closed']).toBeGreaterThan(0)
    // Hysteresis brought it back once the room went quiet.
    expect(health.inputMode).toBe('direct')
    expect(health.processedIngestSeq).toBe(49)
  }, 60_000)
})

describe('flood', () => {
  it('absorbs a flood into aggregate windows without losing a contribution', async () => {
    const active = await play(requireScenario('flood'))

    const result = await active.run(requireScenario('flood'))
    const counters = active.harness.engine.metrics().counters
    const health = active.harness.engine.health()

    const posted = result.envelopesPosted
    expect(posted).toBe(600)
    // Every command is accounted for: applied individually or counted in a
    // window tally. Spec §7.3 마지막 문단 — 기여 수는 보존한다.
    expect((counters['command_direct'] ?? 0) + (counters['command_aggregated'] ?? 0)).toBe(posted)
    expect(health.processedIngestSeq).toBe(posted)
    // The screen is protected: a flood is not one state transition per message.
    expect(counters['commit']).toBeLessThan(posted / 4)
  }, 120_000)
})

describe('paid-replay', () => {
  it('plays without a refusal and refuses both the replayed delivery and the empty combo step', async () => {
    const active = await play(requireScenario('paid-replay'))

    const result = await active.run(requireScenario('paid-replay'))
    const counters = active.harness.engine.metrics().counters

    expect(result.refusals).toEqual([])
    // The replayed Super Chat and the repeated combo step are caught by the
    // inbox's unique key, which is the first of the two defences (§T4); the
    // second is asserted in `paid-integrity.test.ts`.
    expect(result.duplicates).toBeGreaterThan(0)
    expect(counters['gift_no_delta']).toBeGreaterThan(0)
  }, 60_000)
})

describe('degraded-window', () => {
  it('holds events while degraded and applies them in order after recovery', async () => {
    const scenario = requireScenario('degraded-window')
    const samples: {
      atMs: number
      degraded: boolean
      interactionEnabled: boolean
      processedIngestSeq: number
      snapshotInteraction: boolean
    }[] = []
    session = await openSession({
      sliceMs: 5_000,
      onAdvance: (atMs) => {
        const health = session?.harness.engine.health()
        if (health === undefined) return
        samples.push({
          atMs,
          degraded: health.degraded,
          interactionEnabled: health.interactionEnabled,
          processedIngestSeq: health.processedIngestSeq,
          snapshotInteraction: (session as SimulatorSession).harness.engine.snapshot()
            .interactionEnabled,
        })
      },
    })
    const active = session

    const result = await active.run(scenario)
    const health = active.harness.engine.health()

    expect(result.controlsApplied).toEqual(['degrade', 'recover'])
    expect(result.controlsSkipped).toEqual([])

    // Spec §9.2: while degraded the CTA is off, in the read model the renderer
    // would receive and not only in an internal flag.
    const degradedSamples = samples.filter((sample) => sample.degraded)
    expect(degradedSamples.length).toBeGreaterThan(0)
    expect(degradedSamples.every((sample) => !sample.interactionEnabled)).toBe(true)
    expect(degradedSamples.every((sample) => !sample.snapshotInteraction)).toBe(true)
    // Spec §9.2: events received while degraded are neither lost nor shown as
    // accepted — the cursor stands still until the condition clears.
    expect(new Set(degradedSamples.map((sample) => sample.processedIngestSeq))).toEqual(new Set([1]))

    expect(health.interactionEnabled).toBe(true)
    expect(health.degraded).toBe(false)
    // Then the whole backlog is drained in ingestSeq order.
    expect(health.processedIngestSeq).toBe(result.envelopesPosted)
    expect(active.harness.store.hasPaidLedgerEntry(paidKeyOf(scenario))).toBe(true)
  }, 60_000)
})

describe('adversarial', () => {
  it('plays the T6 vectors through the endpoint without a refusal', async () => {
    const scenario = buildAdversarialScenario()
    const active = await play(scenario)

    const result = await active.run(scenario)

    expect(result.refusals).toEqual([])
    expect(result.envelopesPosted).toBeGreaterThan(0)
    expect(result.inserted).toBe(result.envelopesPosted)
  }, 120_000)
})

/** `simulator:{broadcastId}:{messageId}` of the degraded scenario's Super Chat. */
function paidKeyOf(scenario: Scenario): string {
  return `simulator:brd_sim_${scenario.id.replace(/-/g, '_')}:msg_sim_degraded_sc`
}
