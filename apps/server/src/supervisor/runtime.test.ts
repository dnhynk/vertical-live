import { describe, expect, it, vi } from 'vitest'

import type { EngineHealth } from '../engine/engine.js'
import type { SecretName, SecretProvider } from '../secrets/types.js'
import { FakeClock } from '../testing/fake-clock.js'
import { loadSupervisorConfig, type SupervisorConfig } from './config.js'
import { runPreflight } from './preflight.js'
import {
  buildPreflightProbes,
  buildStartupSteps,
  type BroadcastPort,
  type ObsPort,
  type RuntimeDeps,
} from './runtime.js'
import { runStartupSequence } from './startup.js'
import { BASE_ENGINE_HEALTH } from './testing/harness.js'

/**
 * The composition of the §7.3(3) sequence and the §9.2 pre-checks over ports:
 * what runs when, and what a deployment that has not configured an integration
 * is told (`not_configured`, never a silent pass).
 */

function secretsWith(present: readonly SecretName[]): SecretProvider {
  return {
    source: 'test',
    get: (name) => Promise.resolve(present.includes(name) ? `synthetic-${name}` : undefined),
  }
}

function deps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps & { readonly calls: string[] } {
  const calls: string[] = []
  const engineState = { ready: false }
  const chatState = { started: false }
  return {
    calls,
    config: loadSupervisorConfig(),
    engine: {
      start: () => {
        calls.push('engine.start')
        engineState.ready = true
      },
      get ready() {
        return engineState.ready
      },
      health: (): EngineHealth => BASE_ENGINE_HEALTH,
    },
    openStore: () => {
      calls.push('store.open')
    },
    retention: {
      start: () => {
        calls.push('retention.start')
      },
    },
    broadcast: {
      ensureBound: async () => {
        calls.push('broadcast.ensureBound')
        return { broadcastId: 'b1', liveChatId: 'c1' }
      },
      goLive: async () => {
        calls.push('broadcast.goLive')
      },
      publish: async () => {
        calls.push('broadcast.publish')
      },
      bound: () => true,
      publishable: () => true,
    },
    obs: {
      connected: () => true,
      setStreamServiceFromVault: async () => {
        calls.push('obs.setStreamService')
      },
      startStream: async () => {
        calls.push('obs.startStream')
      },
    },
    chat: {
      start: () => {
        calls.push('chat.start')
        chatState.started = true
      },
      started: () => chatState.started,
    },
    ...overrides,
  }
}

describe('buildStartupSteps', () => {
  it('drives the ports in the order the spec fixes', async () => {
    const runtime = deps()

    const result = await runStartupSequence({
      steps: buildStartupSteps(runtime),
      clock: new FakeClock(),
    })

    expect(result.completed).toBe(true)
    expect(runtime.calls).toEqual([
      'store.open',
      'engine.start',
      'retention.start',
      'broadcast.ensureBound',
      // BOARD A-16: the stream key goes in before the output starts.
      'obs.setStreamService',
      'obs.startStream',
      'broadcast.goLive',
      'chat.start',
      'broadcast.publish',
    ])
  })

  it('refuses to continue when the engine did not become ready (spec §7.3(3))', async () => {
    const runtime = deps({
      engine: {
        start: () => {},
        ready: false,
        health: () => BASE_ENGINE_HEALTH,
      },
    })

    const result = await runStartupSequence({
      steps: buildStartupSteps(runtime),
      clock: new FakeClock(),
    })

    expect(result.failedStep).toBe('engine')
    expect(runtime.calls).not.toContain('broadcast.ensureBound')
  })

  it('does not publish while the broadcast is configured private (spec §9.1)', async () => {
    const broadcast: BroadcastPort = {
      ...(deps().broadcast as BroadcastPort),
      publishable: () => false,
    }
    const runtime = deps({ broadcast })

    await runStartupSequence({ steps: buildStartupSteps(runtime), clock: new FakeClock() })

    expect(runtime.calls).not.toContain('broadcast.publish')
  })

  it('fails the chat step when the configured source is not running (review round 1, B2)', async () => {
    // A step that succeeded while no listener existed is what let the run go
    // live without an input path.
    const runtime = deps({
      chat: {
        start: () => {
          /* a source that silently is not there */
        },
        started: () => false,
      },
    })

    const result = await runStartupSequence({
      steps: buildStartupSteps(runtime),
      clock: new FakeClock(),
    })

    expect(result.completed).toBe(false)
    expect(result.failedStep).toBe('chatSource')
    expect(result.error).toContain('chat source did not start')
  })

  it('skips an integration this deployment has not configured', async () => {
    const runtime = deps({ obs: null, broadcast: null, chat: null, retention: null })

    const result = await runStartupSequence({
      steps: buildStartupSteps(runtime),
      clock: new FakeClock(),
    })

    expect(result.completed).toBe(true)
    expect(runtime.calls).toEqual(['store.open', 'engine.start'])
  })
})

describe('buildPreflightProbes', () => {
  const allSecrets: SecretName[] = [
    'server.rendererToken',
    'server.adminToken',
    'youtube.streamKey',
    'alerts.discordWebhookUrl',
  ]

  it('passes when every port answers', async () => {
    const runtime = deps()
    runtime.engine.start()

    const result = await runPreflight(
      buildPreflightProbes({ ...runtime, secrets: secretsWith(allSecrets) }),
      new FakeClock(),
    )

    expect(result.passed).toBe(true)
    expect(result.failed).toEqual([])
  })

  it('names the missing secrets without printing any value (spec §10.2)', async () => {
    const runtime = deps()
    runtime.engine.start()

    const result = await runPreflight(
      buildPreflightProbes({ ...runtime, secrets: secretsWith(['server.rendererToken']) }),
      new FakeClock(),
    )

    const secrets = result.checks.find((check) => check.check === 'secrets')
    expect(secrets?.passed).toBe(false)
    expect(secrets?.reason).toContain('server.adminToken')
    expect(secrets?.reason).not.toContain('synthetic-')
  })

  it('turns a damaged database into a data-integrity safe stop (review round 1, M3)', async () => {
    const corrupt = new Error('database disk image is malformed')
    ;(corrupt as Error & { code: string }).code = 'SQLITE_CORRUPT'
    const runtime = deps({
      openStore: () => {
        throw corrupt
      },
    })
    runtime.engine.start()

    const result = await runPreflight(
      buildPreflightProbes({ ...runtime, secrets: secretsWith(allSecrets) }),
      new FakeClock(),
    )

    const state = result.checks.find((check) => check.check === 'state')
    expect(state?.passed).toBe(false)
    expect(state?.reason).toBe('store:sqlite_sqlite_corrupt')
    expect(result.safeStop?.kind).toBe('data_integrity')
  })

  it('keeps an operational database failure retryable (spec §9.1)', async () => {
    const busy = new Error('database is locked')
    ;(busy as Error & { code: string }).code = 'SQLITE_BUSY'
    const runtime = deps({
      openStore: () => {
        throw busy
      },
    })
    runtime.engine.start()

    const result = await runPreflight(
      buildPreflightProbes({ ...runtime, secrets: secretsWith(allSecrets) }),
      new FakeClock(),
    )

    expect(result.failed).toEqual(['state'])
    expect(result.safeStop).toBeNull()
  })

  it('fails the encoder check while OBS is not connected', async () => {
    const obs: ObsPort = { ...(deps().obs as ObsPort), connected: () => false }
    const runtime = deps({ obs })
    runtime.engine.start()

    const result = await runPreflight(
      buildPreflightProbes({ ...runtime, secrets: secretsWith(allSecrets) }),
      new FakeClock(),
    )

    expect(result.failed).toEqual(['encoder'])
    expect(result.checks.find((check) => check.check === 'encoder')?.reason).toBe(
      'obs_not_connected',
    )
  })

  it('reports an unconfigured integration rather than passing it', async () => {
    const runtime = deps({ obs: null, broadcast: null })
    runtime.engine.start()

    const result = await runPreflight(
      buildPreflightProbes({
        ...runtime,
        secrets: secretsWith([
          'server.rendererToken',
          'server.adminToken',
          'alerts.discordWebhookUrl',
        ]),
      }),
      new FakeClock(),
    )

    expect(result.passed).toBe(false)
    expect(result.failed).toEqual(['credentials', 'api', 'encoder'])
    expect(result.checks.find((check) => check.check === 'api')?.reason).toBe(
      'not_configured:broadcast',
    )
  })

  it('requires the alert and dead-man credentials only when they are enabled', async () => {
    const config: SupervisorConfig = {
      ...loadSupervisorConfig(),
      alerts: { ...loadSupervisorConfig().alerts, discordEnabled: false },
      deadMan: { ...loadSupervisorConfig().deadMan, enabled: true },
    }
    const runtime = deps({ config })
    runtime.engine.start()

    const result = await runPreflight(
      buildPreflightProbes({
        ...runtime,
        secrets: secretsWith(['server.rendererToken', 'server.adminToken', 'youtube.streamKey']),
      }),
      new FakeClock(),
    )

    const secrets = result.checks.find((check) => check.check === 'secrets')
    expect(secrets?.reason).toBe('missing:monitoring.deadManPushUrl')
  })
})

describe('runPreflight', () => {
  it('runs every check even after one fails, so one attempt reports everything', async () => {
    const seen: string[] = []
    const probe = (name: string, passed: boolean) => () => {
      seen.push(name)
      return passed ? { passed: true } : { passed: false, reason: `${name}_failed` }
    }

    const result = await runPreflight(
      {
        credentials: probe('credentials', false),
        secrets: probe('secrets', false),
        state: probe('state', true),
        api: probe('api', true),
        renderer: probe('renderer', true),
        encoder: probe('encoder', true),
      },
      new FakeClock(),
    )

    expect(seen).toHaveLength(6)
    expect(result.failed).toEqual(['credentials', 'secrets'])
  })

  it('turns a probe that throws into a failed check, not a crash', async () => {
    const result = await runPreflight(
      {
        credentials: () => {
          throw new TypeError('boom')
        },
        secrets: () => ({ passed: true }),
        state: () => ({ passed: true }),
        api: () => ({ passed: true }),
        renderer: () => ({ passed: true }),
        encoder: () => ({ passed: true }),
      },
      new FakeClock(),
    )

    expect(result.checks[0]?.reason).toBe('probe_failed:TypeError')
    expect(result.safeStop).toBeNull()
  })

  it('carries the safe-stop kind of a failure a retry cannot fix (spec §9.1)', async () => {
    const ok = () => ({ passed: true })
    const result = await runPreflight(
      {
        credentials: () => ({
          passed: false,
          reason: 'grant_revoked',
          safeStop: 'account_action' as const,
        }),
        secrets: ok,
        state: ok,
        api: ok,
        renderer: ok,
        encoder: ok,
      },
      new FakeClock(),
    )

    expect(result.safeStop?.kind).toBe('account_action')
    expect(result.safeStop?.reason).toBe('preflight_credentials:grant_revoked')
  })

  it('is deterministic about the order it reports the six checks in', async () => {
    const ok = vi.fn(() => ({ passed: true }))
    const result = await runPreflight(
      { credentials: ok, secrets: ok, state: ok, api: ok, renderer: ok, encoder: ok },
      new FakeClock(),
    )

    expect(result.checks.map((check) => check.check)).toEqual([
      'credentials',
      'secrets',
      'state',
      'api',
      'renderer',
      'encoder',
    ])
  })
})
