import { LEAK_MARKERS, REJECTED_VECTORS, ACCEPTED_VECTORS } from '@vl/server/input'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAdversarialScenario } from '../runner/adversarial.js'
import { openSession, type SimulatorSession } from '../runner/session.js'
import { containsAnywhere } from './support.js'

/**
 * Spec §11 "모더레이션":
 *
 * > 악성 이름·Unicode·URL·금칙어·명령 flood replay가 화면이나 상태 규칙을
 * > 우회하지 못한다.
 *
 * The scenario replays T6's own vectors through `POST /ingest/simulator`, and
 * the assertions are made on the two things a viewer or the world could actually
 * see: the inbox rows that were persisted and the frames the renderer received.
 *
 * "Bypass 0" is checked in three ways, because a filter can fail in three ways:
 *
 * 1. **no malicious message became a command** — every rejected vector resolves
 *    as `not_a_world_input`, so it never reaches the reducer (spec §7.3(4));
 * 2. **nothing of the text survives anywhere** — the envelope has no field for
 *    raw chat (spec §7.3(1)), so the leak markers are searched for across every
 *    inbox row, every published snapshot and every effect;
 * 3. **the ordinary messages still work** — a filter that refused everything
 *    would pass (1) and (2) while destroying the product (spec §14.1 명령 성공).
 */

let session: SimulatorSession | null = null

afterEach(async () => {
  await session?.close()
  session = null
})

describe('§11 모더레이션 우회 0', () => {
  it('lets no rejected vector reach the world and keeps every accepted one', async () => {
    const scenario = buildAdversarialScenario()
    session = await openSession()

    const result = await session.run(scenario)
    const counters = session.harness.engine.metrics().counters
    const health = session.harness.engine.health()

    expect(result.refusals).toEqual([])
    expect(result.inserted).toBe(result.envelopesPosted)
    expect(health.processedIngestSeq).toBe(result.envelopesPosted)

    // (1) Every rejected vector became an envelope with no command, and the
    // engine recorded it as "not a world input" rather than applying it.
    expect(counters['event_not_a_world_input']).toBe(REJECTED_VECTORS.length)
    // (3) Every accepted vector still produced a command.
    const applied = (counters['command_direct'] ?? 0) + (counters['command_aggregated'] ?? 0)
    expect(applied).toBe(result.envelopesPosted - REJECTED_VECTORS.length)
  }, 180_000)

  it('leaves no fragment of a rejected message in the persisted inbox', async () => {
    const scenario = buildAdversarialScenario()
    // No renderer: the broadcast is degraded, so the writer holds every row in
    // the inbox instead of draining it (spec §9.2). That is what makes the
    // persisted envelopes readable here — a drained row is behind the cursor.
    session = await openSession({ attachRenderer: false })

    const result = await session.run(scenario)
    const rows = session.harness.store.drainUnprocessed(0, 100_000)

    // (2) The envelope has no field for chat text, and nothing put it in one.
    for (const marker of LEAK_MARKERS) {
      expect(rows.some((row) => containsAnywhere(row.envelope, marker))).toBe(false)
    }
    // The rows really are there — otherwise the search above proves nothing.
    expect(rows.length).toBe(result.envelopesPosted)
    expect(rows.length).toBeGreaterThan(REJECTED_VECTORS.length)
  }, 180_000)

  it('leaves no fragment of a rejected message in a published snapshot or effect', async () => {
    const scenario = buildAdversarialScenario()
    session = await openSession()

    await session.run(scenario)
    const renderer = session.renderer
    if (renderer === null) throw new Error('expected an attached renderer')

    // Nothing the renderer was told to draw carries it either (spec §12.3).
    for (const marker of LEAK_MARKERS) {
      expect(renderer.snapshots.some((snapshot) => containsAnywhere(snapshot, marker))).toBe(false)
      expect(renderer.effectFrames.some((effect) => containsAnywhere(effect, marker))).toBe(false)
    }
    expect(renderer.snapshots.length).toBeGreaterThan(0)
    expect(renderer.effectFrames.length).toBeGreaterThan(0)
  }, 180_000)

  it('absorbs the command flood into aggregate windows', async () => {
    const scenario = buildAdversarialScenario()
    session = await openSession()

    const result = await session.run(scenario)
    const counters = session.harness.engine.metrics().counters

    // Spec §6.4/§7.3: a flood of *valid* commands is tallied, not replayed one
    // state transition at a time.
    expect(counters['command_aggregated']).toBeGreaterThan(0)
    expect(counters['aggregate_window_closed']).toBeGreaterThan(0)
    expect(counters['commit']).toBeLessThan(result.envelopesPosted)
    // And the aliases the flood was made of are the accepted ones, so the flood
    // is a real load test and not a wall of rejections.
    expect(ACCEPTED_VECTORS.length).toBeGreaterThan(0)
  }, 180_000)
})
