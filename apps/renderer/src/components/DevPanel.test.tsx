// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { authenticatedWsUrl, readRendererConfig, redactWsUrl } from '../config'
import { createRuntime, type RendererRuntime } from '../runtime'
import {
  FakeClock,
  FakeFrameScheduler,
  FakeTimers,
  createFakeSocketFactory,
  sequenceRandom,
  type FakeSocketFactory,
} from '../testing/fakes'
import { RendererLog } from '../read-model/log'
import Screen from './Screen'

/**
 * The renderer token must never reach the screen (spec §10.2, CLAUDE.md §3).
 *
 * `?mode=dev` renders configuration verbatim, so a config field that held both
 * the socket address and the vault token put that token on air as soon as the
 * panel was opened (R-T8-2 blocker 1). The fix is structural — `config.wsUrl` is
 * the redacted address and the secret lives in `config.wsToken`, which only
 * `authenticatedWsUrl()` reads — and this file is the proof: a sentinel token is
 * looked for in the DOM, in the log, and in the panel's own diagnostic output.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Obviously synthetic, and long enough that a partial leak still matches. */
const SENTINEL = 'sentinel_renderer_token_do_not_display_0001'
/** The simulator bearer token (T11) is a vault value under the same rule. */
const SIM_SENTINEL = 'sentinel_simulator_token_do_not_display_0002'

interface Harness {
  runtime: RendererRuntime
  container: HTMLElement
  root: Root
  sockets: FakeSocketFactory
}

const mounted: Harness[] = []

function mount(search: string): Harness {
  const clock = new FakeClock()
  const sockets = createFakeSocketFactory()
  const runtime = createRuntime({
    search,
    clock,
    timers: new FakeTimers(clock),
    frameScheduler: new FakeFrameScheduler(),
    socketFactory: sockets.factory,
    random: sequenceRandom([0.5]),
    generateRendererId: () => 'renderer-test',
  })
  runtime.start()
  sockets.last().emitOpen()

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Screen runtime={runtime} />)
  })

  const harness: Harness = { runtime, container, root, sockets }
  mounted.push(harness)
  return harness
}

afterEach(() => {
  while (mounted.length > 0) {
    const harness = mounted.pop() as Harness
    act(() => {
      harness.root.unmount()
    })
    harness.container.remove()
    harness.runtime.stop()
  }
})

describe('dev panel token exposure', () => {
  it('never puts the renderer token on screen', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}`)

    // The panel is open — otherwise the assertion below would pass vacuously.
    expect(harness.container.querySelector('[data-testid="dev-panel"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="dev-ws-url"]')?.textContent).toBe(
      'ws://127.0.0.1:8787/ws/renderer',
    )
    expect(harness.container.innerHTML).not.toContain(SENTINEL)
    expect(harness.container.textContent ?? '').not.toContain(SENTINEL)
  })

  it('keeps the token out of the log the panel renders', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}`)

    const entries = harness.runtime.log.entries()
    expect(entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(entries)).not.toContain(SENTINEL)
    expect(
      harness.container.querySelector('[data-testid="dev-log"]')?.textContent ?? '',
    ).not.toContain(SENTINEL)
  })

  it('still authenticates the socket with the token it did not display', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}`)

    // The one place the secret is allowed: the socket URL.
    expect(harness.sockets.last().url).toBe(`ws://127.0.0.1:8787/ws/renderer?token=${SENTINEL}`)
    expect(harness.runtime.config.wsUrl).not.toContain(SENTINEL)
    expect(harness.runtime.config.wsToken).toBe(SENTINEL)
  })

  it('keeps the token out of a serialized config, however it is dumped', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}`)
    const { wsToken, ...safe } = harness.runtime.config

    // A diagnostic that dumps the config minus the one named secret is clean;
    // this is what makes the field name the whole of the rule to remember.
    expect(wsToken).toBe(SENTINEL)
    expect(JSON.stringify(safe)).not.toContain(SENTINEL)
  })
})

describe('simulator token exposure', () => {
  it('never puts the simulator token on screen or in the log', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}&simToken=${SIM_SENTINEL}`)

    // The injection controls are open — otherwise this passes vacuously.
    expect(harness.container.querySelector('[data-testid="dev-injector"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="dev-sim-auth"]')?.textContent).toBe(
      'token: present',
    )
    expect(harness.container.innerHTML).not.toContain(SIM_SENTINEL)
    expect(JSON.stringify(harness.runtime.log.entries())).not.toContain(SIM_SENTINEL)
    // It is still readable by the one consumer that needs it.
    expect(harness.runtime.config.simToken).toBe(SIM_SENTINEL)
  })

  it('says the token is missing rather than pretending injection works', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}`)

    expect(harness.runtime.config.simToken).toBeNull()
    expect(harness.container.querySelector('[data-testid="dev-sim-auth"]')?.textContent).toContain(
      'missing',
    )
  })

  it('keeps both secrets out of a serialized config, however it is dumped', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}&simToken=${SIM_SENTINEL}`)
    const { wsToken, simToken, ...safe } = harness.runtime.config

    expect(wsToken).toBe(SENTINEL)
    expect(simToken).toBe(SIM_SENTINEL)
    expect(JSON.stringify(safe)).not.toContain(SENTINEL)
    expect(JSON.stringify(safe)).not.toContain(SIM_SENTINEL)
  })

  it('derives the injection endpoint from the socket address, without a token', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}&simToken=${SIM_SENTINEL}`)

    expect(harness.runtime.config.apiUrl).toBe('http://127.0.0.1:8787')
    expect(harness.container.querySelector('[data-testid="dev-api-url"]')?.textContent).toBe(
      'http://127.0.0.1:8787',
    )
  })
})

describe('dev panel injection controls', () => {
  it('is absent from the broadcast screen OBS opens', () => {
    const harness = mount(`?token=${SENTINEL}&simToken=${SIM_SENTINEL}`)

    expect(harness.container.querySelector('[data-testid="dev-panel"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="dev-injector"]')).toBeNull()
  })

  it('offers only the scenarios a browser can play, and no injection changes the read model', () => {
    const harness = mount(`?mode=dev&token=${SENTINEL}&simToken=${SIM_SENTINEL}`)
    const options = [
      ...harness.container.querySelectorAll('[data-testid="dev-scenario-select"] option'),
    ].map((option) => option.textContent)

    expect(options).toEqual(['direct-low', 'aggregate-switch', 'flood', 'paid-replay'])
    // The renderer had no snapshot and the panel cannot give it one: state comes
    // from the server alone (spec §10.2).
    expect(harness.runtime.model.snapshot).toBeNull()
    expect(harness.container.querySelector('[data-testid="dev-sim-result"]')?.textContent).toBe(
      'idle',
    )
  })

  it('sends a pressed button through POST /ingest/simulator and nowhere else', async () => {
    const requests: { url: string; method: string; authorization: string | null; body: string }[] =
      []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      requests.push({
        url,
        method: init.method ?? 'GET',
        authorization: headers['authorization'] ?? null,
        body: String(init.body),
      })
      return Promise.resolve(
        new Response(JSON.stringify({ inserted: 1, duplicates: 0 }), { status: 202 }),
      )
    }) as unknown as typeof fetch

    try {
      const harness = mount(`?mode=dev&token=${SENTINEL}&simToken=${SIM_SENTINEL}`)
      const button = harness.container.querySelector<HTMLButtonElement>(
        '[data-testid="dev-inject-feed"]',
      )
      expect(button).not.toBeNull()

      await act(async () => {
        button?.click()
        await Promise.resolve()
      })

      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe('http://127.0.0.1:8787/ingest/simulator')
      expect(requests[0]?.method).toBe('POST')
      expect(requests[0]?.authorization).toBe(`Bearer ${SIM_SENTINEL}`)
      expect(requests[0]?.body).toContain('"source":"simulator"')
      // The panel reports the endpoint's answer and changes nothing itself: the
      // read model is still waiting for a server snapshot (spec §10.2).
      expect(harness.container.querySelector('[data-testid="dev-sim-result"]')?.textContent).toBe(
        'accepted (202) inserted=1 duplicates=0',
      )
      expect(harness.runtime.model.snapshot).toBeNull()
      // And it is on screen without the token that authorized it.
      expect(harness.container.innerHTML).not.toContain(SIM_SENTINEL)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('url redaction', () => {
  it('removes a token from any url and leaves the rest alone', () => {
    expect(redactWsUrl(`ws://127.0.0.1:8787/ws/renderer?token=${SENTINEL}`)).toBe(
      'ws://127.0.0.1:8787/ws/renderer',
    )
    expect(redactWsUrl('ws://127.0.0.1:9999/ws/renderer?mode=dev')).toBe(
      'ws://127.0.0.1:9999/ws/renderer?mode=dev',
    )
    expect(redactWsUrl('not a url')).toBe('not a url')
  })

  it('refuses a token smuggled through the ws override', () => {
    const log = new RendererLog(new FakeClock())
    const config = readRendererConfig({
      search: `?ws=${encodeURIComponent(`ws://127.0.0.1:9999/ws/renderer?token=${SENTINEL}`)}`,
      log,
      generateRendererId: () => 'renderer-test',
    })

    expect(config.wsUrl).toBe('ws://127.0.0.1:9999/ws/renderer')
    expect(config.wsToken).toBeNull()
    expect(authenticatedWsUrl(config)).toBe('ws://127.0.0.1:9999/ws/renderer')
  })
})
