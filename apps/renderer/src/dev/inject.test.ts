import { describe, expect, it } from 'vitest'

import { parseScenario, planScenario } from '@vl/simulator/scenario'

import { SimulatorClient, SINGLE_EVENTS, panelScenarios } from './inject'

/**
 * `?mode=dev` injection (TASK_SPECS §T11): the panel reaches the world through
 * `POST /ingest/simulator` and through nothing else.
 */

interface Call {
  readonly url: string
  readonly method: string
  readonly authorization: string | null
  readonly body: { envelopes: { source: string; messageId: string; broadcastId: string }[] }
}

function recordingFetch(status = 202, payload: unknown = { inserted: 1, duplicates: 0 }) {
  const calls: Call[] = []
  const fetchImpl = ((url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers['authorization'] ?? null,
      body: JSON.parse(String(init.body)) as Call['body'],
    })
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function client(status = 202, token: string | null = 'sim_token_test') {
  const { calls, fetchImpl } = recordingFetch(status)
  /** Every interval the runner asked to wait, so a skipped one is visible. */
  const waits: number[] = []
  return {
    calls,
    waits,
    simulator: new SimulatorClient({
      apiUrl: 'http://127.0.0.1:8787',
      token,
      fetchImpl,
      now: () => Date.UTC(2026, 7, 16),
      delay: (millis) => {
        waits.push(millis)
        return Promise.resolve()
      },
    }),
  }
}

describe('SimulatorClient.injectSingle', () => {
  it('posts a synthetic simulator envelope to the ingest endpoint', async () => {
    const { calls, simulator } = client()

    const result = await simulator.injectSingle('feed')

    expect(result).toEqual({ outcome: 'accepted', status: 202, inserted: 1, duplicates: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/ingest/simulator')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.authorization).toBe('Bearer sim_token_test')
    const envelope = calls[0]?.body.envelopes[0]
    // Spec §2.6: synthetic participation is labelled as such and its ids say so.
    expect(envelope?.source).toBe('simulator')
    expect(envelope?.messageId.startsWith('msg_sim_')).toBe(true)
    expect(envelope?.broadcastId.startsWith('brd_sim_dev_panel')).toBe(true)
  })

  it('makes a second press a second delivery, not a replay', async () => {
    const { calls, simulator } = client()

    await simulator.injectSingle('feed')
    await simulator.injectSingle('feed')

    expect(calls[0]?.body.envelopes[0]?.broadcastId).not.toBe(
      calls[1]?.body.envelopes[0]?.broadcastId,
    )
  })

  it('offers the free commands and the three paid kinds', () => {
    expect(SINGLE_EVENTS.map((event) => event.id)).toEqual([
      'feed',
      'play',
      'pet',
      'super-chat',
      'gift',
      'membership',
    ])
  })

  it('refuses an unknown button rather than posting something else', async () => {
    const { simulator } = client()

    await expect(simulator.injectSingle('drop-database')).rejects.toThrow('unknown single event')
  })
})

describe('SimulatorClient outcomes', () => {
  it('reports a disabled endpoint as disabled, not as an error', async () => {
    const { simulator } = client(404)

    // §T11 acceptance 3: `simulator.enabled=false` ⇒ 404.
    expect((await simulator.injectSingle('feed')).outcome).toBe('disabled')
  })

  it('reports a missing token as unauthorized and still sends no bearer header', async () => {
    const { calls, simulator } = client(401, null)

    const result = await simulator.injectSingle('feed')

    expect(result.outcome).toBe('unauthorized')
    expect(calls[0]?.authorization).toBeNull()
    expect(simulator.authenticated).toBe(false)
  })

  it('reports an unreachable server without inventing a status', async () => {
    const simulator = new SimulatorClient({
      apiUrl: 'http://127.0.0.1:8787',
      token: 'sim_token_test',
      fetchImpl: (() => Promise.reject(new Error('connection refused'))) as unknown as typeof fetch,
    })

    expect(await simulator.injectSingle('feed')).toEqual({
      outcome: 'unreachable',
      status: null,
      inserted: 0,
      duplicates: 0,
    })
  })
})

describe('SimulatorClient.runScenario', () => {
  it('plays every batch of a built-in scenario through the endpoint', async () => {
    const { calls, simulator } = client()
    const scenario = panelScenarios().find((entry) => entry.id === 'direct-low')
    if (scenario === undefined) throw new Error('expected direct-low in the panel scenarios')

    const result = await simulator.runScenario(scenario)

    expect(result.outcome).toBe('accepted')
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((call) => call.url.endsWith('/ingest/simulator'))).toBe(true)
    expect(
      calls.every((call) =>
        call.body.envelopes.every((envelope) => envelope.source === 'simulator'),
      ),
    ).toBe(true)
  })

  it('crosses the whole scenario, including the trailing wait', async () => {
    const { waits, simulator } = client()
    const scenario = panelScenarios().find((entry) => entry.id === 'direct-low')
    if (scenario === undefined) throw new Error('expected direct-low in the panel scenarios')
    const plan = planScenario(scenario)

    await simulator.runScenario(scenario)

    // The last batch is at 9,000 ms and the scenario ends at 19,000 ms: the
    // trailing `wait` is where the window closes and the tally lands on screen
    // (spec §6.4). Returning at the last POST skipped it (review round 1, M3).
    expect(plan.batches.at(-1)?.atMs).toBeLessThan(plan.endsAtMs)
    expect(waits.reduce((sum, millis) => sum + millis, 0)).toBe(plan.endsAtMs)
  })

  it('waits the full duration of a scenario that is nothing but an interval', async () => {
    const { calls, waits, simulator } = client()
    const scenario = parseScenario({
      id: 'wait-only',
      title: 'Wait only',
      summary: 'One interval and no input at all.',
      steps: [{ kind: 'wait', atMs: 0, durationMs: 4_000 }],
    })

    await simulator.runScenario(scenario)

    expect(calls).toEqual([])
    expect(waits.reduce((sum, millis) => sum + millis, 0)).toBe(4_000)
  })

  it('stops at the first refusal instead of finishing the run', async () => {
    const { calls, simulator } = client(401)
    const scenario = panelScenarios().find((entry) => entry.id === 'direct-low')
    if (scenario === undefined) throw new Error('expected direct-low in the panel scenarios')

    const result = await simulator.runScenario(scenario)

    expect(result.outcome).toBe('unauthorized')
    expect(calls).toHaveLength(1)
  })
})

describe('panelScenarios', () => {
  it('offers only scenarios a browser can actually play', () => {
    const ids = panelScenarios().map((scenario) => scenario.id)

    // No parser (it is a server module) and no virtual clock (the browser's
    // clock is real): those run from `vl-simulator` instead.
    expect(ids).toEqual(['direct-low', 'aggregate-switch', 'flood', 'paid-replay'])
  })
})
