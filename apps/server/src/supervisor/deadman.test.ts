import { describe, expect, it, vi } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import { loadSupervisorConfig } from './config.js'
import { DeadManMonitor } from './deadman.js'

/**
 * Dead-man heartbeat (spec §9.4(8), §11 관측성, [S23]). The external monitor is
 * what notices a host that stopped answering, so what these tests pin is that
 * the push happens on schedule, that a failure is recorded rather than thrown,
 * and that the push URL — a credential — never appears in what we report.
 */

const PUSH_URL = 'https://kuma.example/api/push/synthetic-token'
const config = { ...loadSupervisorConfig().deadMan, enabled: true }

describe('DeadManMonitor', () => {
  it('pushes to the vault URL with an up status and the supervisor state', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    const monitor = new DeadManMonitor({
      pushUrl: () => Promise.resolve(PUSH_URL),
      config,
      clock: new FakeClock(),
      message: () => 'live',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(monitor.push()).resolves.toBe(true)

    const [url] = fetchImpl.mock.calls[0] as unknown as [URL]
    expect(url.toString()).toBe(`${PUSH_URL}?status=up&msg=live`)
    expect(monitor.status()).toMatchObject({ lastPushOk: true, consecutiveFailures: 0 })
  })

  it('pushes on the configured interval once started', async () => {
    const clock = new FakeClock()
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
    const monitor = new DeadManMonitor({
      pushUrl: () => Promise.resolve(PUSH_URL),
      config,
      clock,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    monitor.start()
    expect(fetchImpl).toHaveBeenCalledTimes(0)
    await clock.advance(config.intervalMs)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await clock.advance(config.intervalMs)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    monitor.stop()
    await clock.advance(config.intervalMs * 3)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('counts consecutive failures without throwing', async () => {
    const monitor = new DeadManMonitor({
      pushUrl: () => Promise.resolve(PUSH_URL),
      config,
      clock: new FakeClock(),
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })

    await expect(monitor.push()).resolves.toBe(false)
    await monitor.push()

    expect(monitor.status()).toMatchObject({ lastPushOk: false, consecutiveFailures: 2 })
  })

  it('records an HTTP refusal as a failure with its status', async () => {
    const monitor = new DeadManMonitor({
      pushUrl: () => Promise.resolve(PUSH_URL),
      config,
      clock: new FakeClock(),
      fetchImpl: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    })

    await monitor.push()

    expect(monitor.status().lastError).toBe('http_404')
  })

  it('never puts the push URL in what it reports', async () => {
    const monitor = new DeadManMonitor({
      pushUrl: () => Promise.resolve('not a url'),
      config,
      clock: new FakeClock(),
      fetchImpl: (() => {
        throw new Error('must not be called')
      }) as unknown as typeof fetch,
    })

    await monitor.push()

    expect(monitor.status().lastError).toBe('push_url_malformed')
    expect(JSON.stringify(monitor.status())).not.toContain('synthetic-token')
  })

  it('does nothing at all while it is disabled', async () => {
    const clock = new FakeClock()
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
    const monitor = new DeadManMonitor({
      pushUrl: () => Promise.resolve(PUSH_URL),
      config: { ...config, enabled: false },
      clock,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    monitor.start()
    await clock.advance(config.intervalMs * 3)
    await expect(monitor.push()).resolves.toBe(false)

    expect(monitor.running).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a missing push URL instead of claiming a heartbeat', async () => {
    const monitor = new DeadManMonitor({
      pushUrl: () => Promise.resolve(undefined),
      config,
      clock: new FakeClock(),
      fetchImpl: (() => {
        throw new Error('must not be called')
      }) as unknown as typeof fetch,
    })

    await expect(monitor.push()).resolves.toBe(false)
    expect(monitor.status().lastError).toBe('push_url_not_configured')
  })
})
