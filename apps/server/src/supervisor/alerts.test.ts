import { describe, expect, it, vi } from 'vitest'

import type { LogFields } from '../secrets/redaction.js'
import { FakeClock } from '../testing/fake-clock.js'
import {
  CompositeAlertSink,
  DiscordWebhookAlertSink,
  escapeSlackText,
  formatAlert,
  RecordingAlertSink,
  SlackWebhookAlertSink,
  SuppressingAlertSink,
  type Alert,
  type AlertSink,
} from './alerts.js'
import { loadSupervisorConfig } from './config.js'

/**
 * The operator-notification path of spec §9.1 and §12.3 (BOARD D-3). What the
 * tests pin: delivery never throws, the webhook URL never leaves the vault, and
 * a stuck condition alerts once per window instead of once per evaluation.
 */

const config = loadSupervisorConfig().alerts

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    kind: 'supervisor.degraded',
    severity: 'warning',
    at: '2026-01-01T00:00:00.000Z',
    reason: 'obs_output',
    detail: { degradedFamilies: 'obs_output' },
    ...overrides,
  }
}

describe('SuppressingAlertSink', () => {
  it('delivers the first alert of a key and suppresses repeats inside the window', async () => {
    const clock = new FakeClock()
    const delegate = new RecordingAlertSink()
    const sink = new SuppressingAlertSink({ delegate, config, clock })

    await expect(sink.deliver(alert())).resolves.toMatchObject({ delivered: true })
    await expect(sink.deliver(alert())).resolves.toMatchObject({
      delivered: false,
      suppressed: true,
    })
    expect(delegate.alerts).toHaveLength(1)
  })

  it('reports how many repeats were suppressed when it delivers again', async () => {
    const clock = new FakeClock()
    const delegate = new RecordingAlertSink()
    const sink = new SuppressingAlertSink({ delegate, config, clock })

    await sink.deliver(alert())
    await sink.deliver(alert())
    await sink.deliver(alert())
    await clock.advance(config.suppressWindowMs.warning + 1)
    await sink.deliver(alert())

    expect(delegate.alerts).toHaveLength(2)
    expect(delegate.alerts[1]?.detail['suppressedSincePrevious']).toBe(2)
  })

  it('keys suppression on kind and reason, so a different fault still gets through', async () => {
    const delegate = new RecordingAlertSink()
    const sink = new SuppressingAlertSink({ delegate, config, clock: new FakeClock() })

    await sink.deliver(alert())
    await sink.deliver(alert({ reason: 'renderer' }))

    expect(delegate.alerts).toHaveLength(2)
  })

  it('uses the shorter window for a critical alert', async () => {
    const clock = new FakeClock()
    const delegate = new RecordingAlertSink()
    const sink = new SuppressingAlertSink({ delegate, config, clock })

    await sink.deliver(alert({ severity: 'critical' }))
    await clock.advance(config.suppressWindowMs.critical + 1)
    await sink.deliver(alert({ severity: 'critical' }))

    expect(config.suppressWindowMs.critical).toBeLessThan(config.suppressWindowMs.warning)
    expect(delegate.alerts).toHaveLength(2)
  })
})

describe('DiscordWebhookAlertSink', () => {
  it('posts the alert to the vault URL and reports delivery', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const sink = new DiscordWebhookAlertSink({
      webhookUrl: () => Promise.resolve('https://discord.example/api/webhooks/1/synthetic-token'),
      config,
      clock: new FakeClock(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toEqual({
      delivered: true,
      suppressed: false,
      error: null,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      content: formatAlert(alert()),
    })
  })

  it('reports a refused delivery instead of throwing, and logs it without the URL', async () => {
    const logged: { message: string; fields?: LogFields }[] = []
    const sink = new DiscordWebhookAlertSink({
      webhookUrl: () => Promise.resolve('https://discord.example/api/webhooks/1/synthetic-token'),
      config,
      clock: new FakeClock(),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message, fields) => logged.push({ message, ...(fields ? { fields } : {}) }),
      },
      fetchImpl: (async () => new Response(null, { status: 429 })) as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toEqual({
      delivered: false,
      suppressed: false,
      error: 'http_429',
    })
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged)).not.toContain('synthetic-token')
  })

  it('reports a missing webhook URL rather than pretending to have alerted', async () => {
    const sink = new DiscordWebhookAlertSink({
      webhookUrl: () => Promise.resolve(undefined),
      config,
      clock: new FakeClock(),
      fetchImpl: (() => {
        throw new Error('must not be called')
      }) as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toMatchObject({
      delivered: false,
      error: 'webhook_url_not_configured',
    })
  })

  it('survives a transport that throws', async () => {
    const sink = new DiscordWebhookAlertSink({
      webhookUrl: () => Promise.resolve('https://discord.example/api/webhooks/1/synthetic-token'),
      config,
      clock: new FakeClock(),
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toMatchObject({ delivered: false })
  })
})

describe('SlackWebhookAlertSink', () => {
  const webhookUrl = 'https://hooks.slack.example/services/T1/B1/synthetic-token'

  it('posts the alert as a `text` message and reports delivery on a 200 ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    const sink = new SlackWebhookAlertSink({
      webhookUrl: () => Promise.resolve(webhookUrl),
      config,
      clock: new FakeClock(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toEqual({
      delivered: true,
      suppressed: false,
      error: null,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ text: formatAlert(alert()) })
  })

  it('escapes the three mrkdwn control characters so a token renders as itself', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }))
    const sink = new SlackWebhookAlertSink({
      webhookUrl: () => Promise.resolve(webhookUrl),
      config,
      clock: new FakeClock(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await sink.deliver(alert({ detail: { range: '<a&b>' } }))

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const { text } = JSON.parse(String(init.body)) as { text: string }
    expect(text).toContain('range=&lt;a&amp;b&gt;')
    expect(text).not.toContain('<a&b>')
  })

  it('reports a refused delivery instead of throwing, and logs it without the URL', async () => {
    const logged: { message: string; fields?: LogFields }[] = []
    const sink = new SlackWebhookAlertSink({
      webhookUrl: () => Promise.resolve(webhookUrl),
      config,
      clock: new FakeClock(),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message, fields) => logged.push({ message, ...(fields ? { fields } : {}) }),
      },
      fetchImpl: (async () =>
        new Response('invalid_payload', { status: 400 })) as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toEqual({
      delivered: false,
      suppressed: false,
      error: 'http_400',
    })
    expect(logged).toHaveLength(1)
    expect(JSON.stringify(logged)).not.toContain('synthetic-token')
  })

  it('reports the published rate limit as a delivery failure rather than dropping it', async () => {
    const sink = new SlackWebhookAlertSink({
      webhookUrl: () => Promise.resolve(webhookUrl),
      config,
      clock: new FakeClock(),
      fetchImpl: (async () => new Response(null, { status: 429 })) as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toMatchObject({
      delivered: false,
      error: 'http_429',
    })
  })

  it('reports a missing webhook URL rather than pretending to have alerted', async () => {
    const sink = new SlackWebhookAlertSink({
      webhookUrl: () => Promise.resolve(undefined),
      config,
      clock: new FakeClock(),
      fetchImpl: (() => {
        throw new Error('must not be called')
      }) as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toMatchObject({
      delivered: false,
      error: 'webhook_url_not_configured',
    })
  })

  it('survives a transport that throws', async () => {
    const sink = new SlackWebhookAlertSink({
      webhookUrl: () => Promise.resolve(webhookUrl),
      config,
      clock: new FakeClock(),
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })

    await expect(sink.deliver(alert())).resolves.toMatchObject({ delivered: false })
  })
})

describe('escapeSlackText', () => {
  it('converts only the three control characters', () => {
    expect(escapeSlackText('a&b<c>d')).toBe('a&amp;b&lt;c&gt;d')
    expect(escapeSlackText('[critical] vertical-live x: y (z)')).toBe(
      '[critical] vertical-live x: y (z)',
    )
  })
})

describe('CompositeAlertSink', () => {
  it('reports delivered when at least one transport took it', async () => {
    const good = new RecordingAlertSink()
    const bad: AlertSink = {
      name: 'bad',
      deliver: () => Promise.resolve({ delivered: false, suppressed: false, error: 'http_500' }),
    }

    await expect(new CompositeAlertSink([good, bad]).deliver(alert())).resolves.toMatchObject({
      delivered: true,
      error: 'http_500',
    })
  })
})

describe('formatAlert', () => {
  it('carries only machine tokens the supervisor produced', () => {
    const text = formatAlert(
      alert({ detail: { degradedFamilies: 'obs_output', interactionEnabled: false } }),
    )

    expect(text).toContain('[warning] vertical-live supervisor.degraded: obs_output')
    expect(text).toContain('degradedFamilies=obs_output')
    expect(text).toContain('interactionEnabled=false')
  })
})
