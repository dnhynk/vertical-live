import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createServer, DEFAULT_PORT, resolvePort, type ServerOptions } from './server.js'
import type { EngineHealth } from './engine/engine.js'
import type { EngineMetricsSnapshot } from './engine/metrics.js'
import { CommandMetrics, type CommandMetricsSnapshot } from './input/metrics.js'
import { parseMessage } from './input/parse.js'
import type { HealthSignal } from './health/types.js'
import { AdminKillEndpoint, type KillSwitchRequest } from './supervisor/kill-switch.js'
import { AdminModerationEndpoint, type ModerationReport } from './supervisor/moderation-report.js'
import type { SupervisorHealthSummary } from './supervisor/types.js'
import { FakeClock } from './testing/fake-clock.js'
import { QuotaTracker } from './youtube/quota/tracker.js'

describe('resolvePort', () => {
  it('falls back to the shared default', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT)
    expect(resolvePort({ VL_PORT: '' })).toBe(DEFAULT_PORT)
  })

  it('reads VL_PORT', () => {
    expect(resolvePort({ VL_PORT: '9123' })).toBe(9123)
  })

  it('rejects a non-port VL_PORT', () => {
    expect(() => resolvePort({ VL_PORT: 'abc' })).toThrow(/invalid VL_PORT/)
    expect(() => resolvePort({ VL_PORT: '70000' })).toThrow(/invalid VL_PORT/)
  })
})

describe('health server', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    server = createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('answers GET /health with {status:"ok"}', async () => {
    const response = await fetch(`${baseUrl}/health`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('rejects an unknown path with 404', async () => {
    const response = await fetch(`${baseUrl}/nope`)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'not_found' })
  })

  it('rejects a non-GET method on /health with 405', async () => {
    const response = await fetch(`${baseUrl}/health`, { method: 'POST' })

    expect(response.status).toBe(405)
    await expect(response.json()).resolves.toEqual({ error: 'method_not_allowed' })
  })

  it('has no /metrics and no simulator endpoint without an engine', async () => {
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/ingest/simulator`, { method: 'POST' })).status).toBe(404)
  })
})

/**
 * The observability surface of TASK_SPECS 공통 규약. A route whose collaborator
 * is absent must be indistinguishable from a path that does not exist — the
 * simulator endpoint in particular (§T11 acceptance 3).
 */
describe('engine-backed routes', () => {
  const health: EngineHealth = {
    ready: true,
    degraded: false,
    degradedReasons: [],
    interactionEnabled: true,
    stateRevision: 12,
    processedIngestSeq: 7,
    lastCommittedAt: '2026-08-16T00:05:00.000Z',
    openEffectCount: 1,
    rendererCount: 1,
    lastAckedStateRevision: 12,
    inputMode: 'direct',
    broadcastLifecycle: 'live',
    lastFailure: null,
    consecutiveFailures: 0,
    ingestRejected: {
      invalid: { count: 0, byCode: {}, lastCode: null, lastAt: null },
      unsupported: { count: 0, lastAt: null },
    },
  }
  const metrics: EngineMetricsSnapshot = {
    latencyMs: {
      receivedToCommitted: { count: 3, p50Ms: 4, p95Ms: 9, maxMs: 11 },
      committedToPublished: { count: 3, p50Ms: 0, p95Ms: 1, maxMs: 1 },
      publishedToAcked: { count: 3, p50Ms: 2, p95Ms: 3, maxMs: 3 },
      receivedToAcked: { count: 3, p50Ms: 7, p95Ms: 12, maxMs: 12 },
    },
    counters: { commit: 3 },
  }

  let server: Server
  let baseUrl: string
  let degraded = false

  const options: ServerOptions = {
    engine: {
      health: () =>
        degraded ? { ...health, degraded: true, degradedReasons: ['no_renderer'] } : health,
      metrics: () => metrics,
    },
    rendererHealth: () => null,
    sourceHealth: () => sourceSignals,
  }
  let sourceSignals: HealthSignal[] = []

  beforeEach(async () => {
    degraded = false
    sourceSignals = []
    server = createServer(options)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('reports the engine under /health', async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as {
      status: string
      engine: EngineHealth
      renderer: unknown
    }

    expect(body.status).toBe('ok')
    expect(body.engine).toEqual(health)
    expect(body.renderer).toBeNull()
  })

  it('reports source signals without letting them decide the status line', async () => {
    // A chat transport that is merely reconnecting is `unknown`, and §9.4(3)
    // leaves the verdict to T12's supervisor — `/health` reports, it does not
    // judge.
    sourceSignals = [
      {
        component: 'youtube-chat',
        name: 'youtube.chat.transport',
        status: 'degraded',
        observedAtUtc: '2026-08-17T00:00:00.000Z',
        observedAtMonotonicMs: 1,
        reason: 'retry_budget_exhausted',
        detail: { mode: 'grpc', connected: false },
      },
    ]
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as {
      status: string
      sources: HealthSignal[]
    }

    expect(body.status).toBe('ok')
    expect(body.sources).toEqual(sourceSignals)
  })

  it('reports combined quota usage in a chat-only posture', async () => {
    const quota = new QuotaTracker({ clock: new FakeClock() })
    quota.record('liveChatMessages.streamList', 2)
    quota.record('liveChatMessages.list', 3)
    const chatOnly = createServer({ ...options, quotaUsage: () => quota.snapshot() })
    await new Promise<void>((resolve) => {
      chatOnly.listen(0, '127.0.0.1', resolve)
    })
    const url = `http://127.0.0.1:${String((chatOnly.address() as AddressInfo).port)}`

    try {
      const body = (await (await fetch(`${url}/health`)).json()) as {
        quota: ReturnType<QuotaTracker['snapshot']>
      }
      expect(body.quota.spentUnits).toBe(5)
      expect(body.quota.byMethod).toEqual({
        'liveChatMessages.streamList': 2,
        'liveChatMessages.list': 3,
      })
    } finally {
      await new Promise<void>((resolve) => chatOnly.close(() => resolve()))
    }
  })

  it('reports degraded in the status line, not only in the detail', async () => {
    degraded = true
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as { status: string }

    expect(body.status).toBe('degraded')
  })

  it('serves the latency histograms under /metrics', async () => {
    const response = await fetch(`${baseUrl}/metrics`)

    expect(response.status).toBe(200)
    // A process that is not parsing commands still answers, and says so with
    // `null` rather than an empty snapshot that would read as "zero commands"
    // (T31).
    await expect(response.json()).resolves.toEqual({ ...metrics, command: null })
  })

  it('serves the command counters under /metrics when a collector is wired', async () => {
    // The real collector, not a literal: `/metrics` has to show what the
    // supervisor is reading, and a hand-written snapshot could agree with the
    // endpoint while disagreeing with the thing that counts (T31).
    const collector = new CommandMetrics()
    for (const text of ['feed', 'ごはん', 'feed https://example.invalid', 'a']) {
      collector.recordParse(
        parseMessage(
          text,
          { identityGateOpen: false, voteWindowOpen: false },
          { maxRawLength: 500 },
        ),
      )
    }
    const withCommands = createServer({ ...options, commandMetrics: () => collector.snapshot() })
    await new Promise<void>((resolve) => {
      withCommands.listen(0, '127.0.0.1', resolve)
    })
    const url = `http://127.0.0.1:${(withCommands.address() as AddressInfo).port}`

    try {
      const body = (await (await fetch(`${url}/metrics`)).json()) as {
        command: CommandMetricsSnapshot
      }

      expect(body.command).toEqual(collector.snapshot())
      // Spec §14.1's two values reach an operator: the anonymous command count
      // and the success ratio.
      expect(body.command.commandLike).toBe(4)
      expect(body.command.commandSuccessRatio).toBe(0.5)
      // Anonymous integers only, and the consent fields stay absent while that
      // gate is closed — the document is what it was before D-9.
      expect(Object.keys(body.command)).not.toContain('consentAccepted')
      expect(Object.keys(body.command)).not.toContain('suppressed')
    } finally {
      await new Promise<void>((resolve) => {
        withCommands.close(() => {
          resolve()
        })
      })
    }
  })

  it('rejects a non-GET method on /metrics', async () => {
    expect((await fetch(`${baseUrl}/metrics`, { method: 'POST' })).status).toBe(405)
  })

  it('has no /admin/kill until something can be stopped', async () => {
    expect((await fetch(`${baseUrl}/admin/kill`, { method: 'POST' })).status).toBe(404)
  })

  it('has no /admin/moderation until there is a supervisor to report to', async () => {
    expect((await fetch(`${baseUrl}/admin/moderation`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${baseUrl}/admin/moderation/clear`, { method: 'POST' })).status).toBe(404)
  })
})

/**
 * The supervisor surface of TASK_SPECS §T12: the state machine and its §9.4
 * family summary on `/health`, and the kill switch on `POST /admin/kill`
 * (loopback + `server.adminToken`, spec §10.2).
 */
describe('supervisor routes', () => {
  const health: EngineHealth = {
    ready: true,
    degraded: false,
    degradedReasons: [],
    interactionEnabled: true,
    stateRevision: 3,
    processedIngestSeq: 9,
    lastCommittedAt: '2026-01-01T00:00:00.000Z',
    openEffectCount: 0,
    rendererCount: 1,
    lastAckedStateRevision: 3,
    inputMode: 'direct',
    broadcastLifecycle: 'live',
    lastFailure: null,
    consecutiveFailures: 0,
    ingestRejected: {
      invalid: { count: 0, byCode: {}, lastCode: null, lastAt: null },
      unsupported: { count: 0, lastAt: null },
    },
  }

  const summary: SupervisorHealthSummary = {
    state: 'live',
    since: '2026-01-01T00:00:00.000Z',
    lastTransitionReason: 'signals:all_families_ok',
    safeStop: null,
    interactionEnabled: true,
    moderation: {
      status: 'ok',
      reason: null,
      reportedAtUtc: null,
      filterEvasion: {
        enabled: true,
        reported: false,
        consecutiveExceeding: 0,
        consecutiveBelow: 0,
        windowsClosed: 2,
        lastWindow: null,
      },
    },
    families: [
      {
        family: 'obs_output',
        specItem: 5,
        status: 'ok',
        reason: null,
        sources: ['obs.stream'],
        observedAtUtc: '2026-01-01T00:00:00.000Z',
        unknownForMs: null,
        unobservableEscalated: false,
      },
    ],
    components: [],
    preflight: [],
    deadMan: {
      enabled: false,
      lastPushAt: null,
      lastPushOk: null,
      consecutiveFailures: 0,
      lastError: null,
    },
  }

  const killed: KillSwitchRequest[] = []
  const reported: ModerationReport[] = []
  const cleared: string[] = []
  let state: SupervisorHealthSummary = summary
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    killed.length = 0
    reported.length = 0
    cleared.length = 0
    state = summary
    server = createServer({
      engine: { health: () => health, metrics: () => ({}) as EngineMetricsSnapshot },
      supervisorHealth: () => state,
      adminKill: new AdminKillEndpoint({
        token: 'synthetic-admin-token',
        onKill: (request) => killed.push(request),
      }),
      adminModeration: new AdminModerationEndpoint({
        token: 'synthetic-admin-token',
        onReport: (report) => reported.push(report),
        onClear: (at) => cleared.push(at),
      }),
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('reports the state machine and the family summary under /health', async () => {
    const body = (await (await fetch(`${baseUrl}/health`)).json()) as {
      status: string
      supervisor: SupervisorHealthSummary
    }

    expect(body.status).toBe('ok')
    expect(body.supervisor.state).toBe('live')
    expect(body.supervisor.families[0]?.specItem).toBe(5)
  })

  it('lets the supervisor, not the engine, decide the status line', async () => {
    state = {
      ...summary,
      state: 'safe_stopped',
      safeStop: {
        kind: 'rights_or_policy',
        at: '2026-01-01T00:00:00.000Z',
        reason: 'broadcast_limit_unrecoverable',
        detail: {},
      },
    }

    const body = (await (await fetch(`${baseUrl}/health`)).json()) as { status: string }

    // The writer inside a stopped run being fine does not make the run `ok`.
    expect(body.status).toBe('safe_stopped')
  })

  it('accepts POST /admin/kill from loopback with the token', async () => {
    const response = await fetch(`${baseUrl}/admin/kill`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-admin-token' },
      body: JSON.stringify({ reason: 'operator' }),
    })

    expect(response.status).toBe(202)
    expect(killed).toHaveLength(1)
    expect(killed[0]?.source).toBe('http')
  })

  it('accepts an empty body: a kill switch must not require valid JSON', async () => {
    const response = await fetch(`${baseUrl}/admin/kill`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-admin-token' },
    })

    expect(response.status).toBe(202)
    expect(killed[0]?.reason).toBe('admin_http')
  })

  it('refuses a request with no or a wrong token', async () => {
    expect((await fetch(`${baseUrl}/admin/kill`, { method: 'POST' })).status).toBe(401)
    expect(
      (
        await fetch(`${baseUrl}/admin/kill`, {
          method: 'POST',
          headers: { authorization: 'Bearer nope' },
        })
      ).status,
    ).toBe(401)
    expect(killed).toHaveLength(0)
  })

  it('rejects a non-POST method on /admin/kill', async () => {
    expect((await fetch(`${baseUrl}/admin/kill`)).status).toBe(405)
    expect(killed).toHaveLength(0)
  })

  it('routes POST /admin/moderation to the report endpoint (§12.3, §T22)', async () => {
    const response = await fetch(`${baseUrl}/admin/moderation`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-admin-token' },
      body: JSON.stringify({ reason: 'pii_exposure', note: 'synthetic' }),
    })

    expect(response.status).toBe(202)
    expect(reported).toHaveLength(1)
    expect(reported[0]?.reason).toBe('pii_exposure')
  })

  it('routes POST /admin/moderation/clear to the clear endpoint', async () => {
    const response = await fetch(`${baseUrl}/admin/moderation/clear`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-admin-token' },
    })

    expect(response.status).toBe(202)
    expect(cleared).toHaveLength(1)
    expect(reported).toHaveLength(0)
  })

  it('refuses an unauthenticated or unknown-token moderation report', async () => {
    expect((await fetch(`${baseUrl}/admin/moderation`, { method: 'POST' })).status).toBe(401)
    const unknown = await fetch(`${baseUrl}/admin/moderation`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-admin-token' },
      body: JSON.stringify({ reason: 'chat_is_bad' }),
    })

    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ error: 'unknown_reason' })
    expect(reported).toHaveLength(0)
  })

  it('refuses an unreadable body rather than reporting without a reason', async () => {
    const response = await fetch(`${baseUrl}/admin/moderation`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-admin-token' },
      body: 'not json',
    })

    expect(response.status).toBe(400)
    expect(reported).toHaveLength(0)
  })

  it('rejects a non-POST method on the moderation routes', async () => {
    expect((await fetch(`${baseUrl}/admin/moderation`)).status).toBe(405)
    expect((await fetch(`${baseUrl}/admin/moderation/clear`)).status).toBe(405)
    expect(reported).toHaveLength(0)
    expect(cleared).toHaveLength(0)
  })
})

/**
 * `POST /admin/kill` reads its body the same way `POST /ingest/simulator` does,
 * so it had the same hang: a throw inside the `.then()` handler rejected a
 * promise nobody held, and the response was never written (T8b). The kill switch
 * reaches the supervisor, so `onKill` failing is not hypothetical — and an
 * operator killing a wedged broadcast is exactly who must not be left waiting.
 */
describe('/admin/kill when the kill itself fails', () => {
  let server: Server
  let baseUrl: string
  const leaked: unknown[] = []
  const recordLeak = (reason: unknown): void => {
    leaked.push(reason)
  }

  beforeEach(async () => {
    leaked.length = 0
    process.on('unhandledRejection', recordLeak)
    server = createServer({
      adminKill: new AdminKillEndpoint({
        token: 'synthetic-admin-token',
        onKill: () => {
          throw new Error('supervisor refused the stop')
        },
      }),
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterEach(async () => {
    process.off('unhandledRejection', recordLeak)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('answers 500 instead of leaving the operator waiting', async () => {
    const response = await fetch(`${baseUrl}/admin/kill`, {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-admin-token' },
      body: JSON.stringify({ reason: 'operator' }),
      signal: AbortSignal.timeout(2_000),
    })
    for (let index = 0; index < 3; index += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
    }

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'internal_error' })
    expect(leaked).toEqual([])
  })
})
