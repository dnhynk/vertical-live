import { afterEach, describe, expect, it } from 'vitest'

import { planScenario, findBuiltinScenario, type Scenario } from '../scenario/index.js'
import { VirtualClock } from './clock.js'
import { SimulatorHarness } from './harness.js'
import { postEnvelopes } from './inject.js'

/**
 * The endpoint contract of TASK_SPECS §T11 acceptance 3:
 *
 * > 시뮬레이터가 만든 이벤트는 `source: "simulator"`로만 표시되고 공개 방송
 * > 경로에서 `simulator.enabled=false`면 엔드포인트가 404다.
 *
 * Both halves are checked against the real HTTP surface, and so are the refusals
 * around them: no token, wrong token, a body the schema rejects, and the CORS
 * preflight the `?mode=dev` panel needs.
 */

let harness: SimulatorHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

function scenario(id: string): Scenario {
  const found = findBuiltinScenario(id)
  if (found === null) throw new Error(`missing built-in scenario ${id}`)
  return found
}

/** The first batch of `direct-low`, as envelopes stamped with one instant. */
function sampleEnvelopes(clock: VirtualClock) {
  const plan = planScenario(scenario('direct-low'))
  const batch = plan.batches[0]
  if (batch === undefined) throw new Error('expected a first batch')
  return batch.build(clock.nowUtcIso())
}

async function open(options: { enabled?: boolean } = {}): Promise<SimulatorHarness> {
  const clock = new VirtualClock()
  const created = new SimulatorHarness({
    clock,
    ...(options.enabled === undefined ? {} : { simulatorEnabled: options.enabled }),
  })
  await created.start()
  harness = created
  return created
}

describe('POST /ingest/simulator', () => {
  it('accepts a simulator batch and records it as source "simulator"', async () => {
    const active = await open()
    const clock = active.clock as VirtualClock

    const response = await postEnvelopes(
      { baseUrl: active.baseUrl, token: active.simulatorToken },
      sampleEnvelopes(clock),
    )

    expect(response.status).toBe(202)
    expect(response.inserted).toBe(1)
    const rows = active.store.drainUnprocessed(0, 10)
    expect(rows.every((row) => row.envelope.source === 'simulator')).toBe(true)
    expect(rows.every((row) => row.envelope.sourceShape === 'simulator')).toBe(true)
  })

  it('answers 404 for every method while simulator.enabled is false', async () => {
    const active = await open({ enabled: false })
    const clock = active.clock as VirtualClock

    const posted = await postEnvelopes(
      { baseUrl: active.baseUrl, token: active.simulatorToken },
      sampleEnvelopes(clock),
    )
    const preflight = await fetch(`${active.baseUrl}/ingest/simulator`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5173' },
    })

    expect(posted.status).toBe(404)
    expect(posted.error).toBe('not_found')
    // A production broadcast must not even admit the path exists.
    expect(preflight.status).toBe(404)
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses an unauthenticated or wrongly-authenticated caller', async () => {
    const active = await open()
    const clock = active.clock as VirtualClock
    const envelopes = sampleEnvelopes(clock)

    const anonymous = await postEnvelopes({ baseUrl: active.baseUrl, token: null }, envelopes)
    const wrong = await postEnvelopes(
      { baseUrl: active.baseUrl, token: 'sim_token_not_the_one' },
      envelopes,
    )

    expect(anonymous.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(active.store.drainUnprocessed(0, 10)).toEqual([])
  })

  it('refuses an envelope that claims to come from YouTube', async () => {
    const active = await open()
    const clock = active.clock as VirtualClock
    const [envelope] = sampleEnvelopes(clock)
    if (envelope === undefined) throw new Error('expected an envelope')

    const response = await postEnvelopes({ baseUrl: active.baseUrl, token: active.simulatorToken }, [
      { ...envelope, source: 'youtube' },
    ])

    // Spec §2.6: synthetic participation may never present itself as real.
    expect(response.status).toBe(400)
    expect(response.error).toBe('source_must_be_simulator')
  })

  it('answers the dev panel preflight for a loopback origin only', async () => {
    const active = await open()

    const loopback = await fetch(`${active.baseUrl}/ingest/simulator`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    })
    const elsewhere = await fetch(`${active.baseUrl}/ingest/simulator`, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.invalid' },
    })

    expect(loopback.status).toBe(204)
    expect(loopback.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(loopback.headers.get('access-control-allow-headers')).toContain('authorization')
    // No wildcard and no echo of a foreign origin.
    expect(elsewhere.status).toBe(204)
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull()
  })
})
