import { describe, expect, it, vi } from 'vitest'

import type { EngineHealth } from '../engine/engine.js'
import type { SecretName, SecretProvider } from '../secrets/types.js'
import { FakeClock, flushMicrotasks } from '../testing/fake-clock.js'
import { createExponentialBackoff } from '../youtube/quota/backoff.js'
import { loadSupervisorConfig, type SupervisorConfig } from './config.js'
import { runPreflight } from './preflight.js'
import { RestartSupervisor } from './restart.js'
import {
  buildPreflightProbes,
  buildStartupSteps,
  chatRestartReadinessTimeoutMs,
  obsStreamRecoveryVerificationTimeoutMs,
  restartChatSource,
  type BroadcastPort,
  type ObsPort,
  type RestartableChatPort,
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
  const chatState = { ready: false }
  return {
    calls,
    config: loadSupervisorConfig(),
    // Auto-advancing: the chat step sleeps in a loop until the listener reports
    // it is running, which is exactly what this mode is for.
    clock: new FakeClock({ autoAdvance: true }),
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
        chatState.ready = true
      },
      started: () => chatState.ready,
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

  it('fails the chat step when the configured source never starts (round 1 B2, round 2)', async () => {
    // A step that succeeded while no listener was running is what let the run go
    // live without an input path. Starting is asynchronous, so the step waits —
    // and gives up at `supervisor.chatStart.timeoutMs`.
    const runtime = deps({
      chat: {
        start: () => {
          /* a source that never leaves idle */
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
    expect(result.error).toContain('chat source did not become ready')
  })

  it('stops waiting for the listener when the run stops (round 3)', async () => {
    // The chat wait is the longest window in the sequence, so it is also the
    // most likely one for a kill switch to land in: the loop watches for it
    // instead of holding the sequence open until the timeout.
    let polls = 0
    let running = true
    const runtime = deps({
      chat: {
        start: () => {},
        started: () => {
          polls += 1
          if (polls === 2) running = false
          return false
        },
      },
    })

    const result = await runStartupSequence({
      steps: buildStartupSteps(runtime),
      clock: new FakeClock(),
      canContinue: () => running,
    })

    expect(result.aborted).toBe(true)
    // Not a timeout failure: the run stopped, so no retry is spent.
    expect(result.failedStep).toBeNull()
    expect(polls).toBeLessThan(5)
  })

  it('waits for the canonical transport readiness signal (round 2, T51)', async () => {
    // `started()` flips only after the selected path reports transport `ok`, so
    // the step does not accept mode selection while it is still dialling.
    let polls = 0
    const runtime = deps({
      chat: {
        start: () => {},
        started: () => {
          polls += 1
          return polls > 3
        },
      },
    })

    const result = await runStartupSequence({
      steps: buildStartupSteps(runtime),
      clock: new FakeClock(),
    })

    expect(result.completed).toBe(true)
    expect(polls).toBeGreaterThan(3)
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

describe('restartChatSource (T51)', () => {
  const backoff = () =>
    createExponentialBackoff({
      initialDelayMs: 1000,
      maxDelayMs: 2000,
      factor: 2,
      jitterRatio: 0,
      maxAttempts: 2,
      random: () => 0,
    })

  it('keeps one attempt in flight until the transport is ready', async () => {
    const clock = new FakeClock()
    const effects: string[] = []
    let ready = false
    const chat: RestartableChatPort = {
      stop: () => {
        effects.push('stop')
        return Promise.resolve()
      },
      start: () => effects.push('start'),
      started: () => ready,
    }
    const supervisor = new RestartSupervisor({
      component: 'chat-source',
      clock,
      backoff: backoff(),
      restart: (signal) =>
        restartChatSource({
          chat,
          clock,
          timeoutMs: 55_000,
          pollIntervalMs: 250,
          signal,
        }),
    })

    expect(supervisor.request('chat_transport')).toBe('scheduled')
    await clock.advance(1000)
    expect(effects).toEqual(['stop', 'start'])
    expect(supervisor.inFlight).toBe(true)

    // The incident spent all three attempts in 13s. Every equivalent recovery
    // tick now sees the first attempt still verifying instead.
    for (let elapsed = 0; elapsed < 14_000; elapsed += 2000) {
      expect(supervisor.request('chat_transport')).toBe('in_flight')
      await clock.advance(2000)
    }
    expect(supervisor.attempts).toBe(1)

    ready = true
    await clock.advance(250)
    expect(supervisor.inFlight).toBe(false)
    expect(supervisor.health().lastError).toBeNull()
  })

  it('uses the pacing floor plus the existing readiness window', () => {
    expect(chatRestartReadinessTimeoutMs(30_000, 25_000)).toBe(55_000)
    expect(() => chatRestartReadinessTimeoutMs(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError)
  })

  it('uses the existing YouTube ingest window plus one health poll for OBS recovery', () => {
    expect(obsStreamRecoveryVerificationTimeoutMs(120_000, 20_000)).toBe(140_000)
    expect(() => obsStreamRecoveryVerificationTimeoutMs(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      RangeError,
    )
  })

  it('times out as a failed attempt and preserves bounded exhaustion', async () => {
    const clock = new FakeClock()
    const chat: RestartableChatPort = {
      stop: () => Promise.resolve(),
      start: () => {},
      started: () => false,
    }
    const supervisor = new RestartSupervisor({
      component: 'chat-source',
      clock,
      backoff: backoff(),
      restart: (signal) =>
        restartChatSource({ chat, clock, timeoutMs: 1000, pollIntervalMs: 250, signal }),
    })

    supervisor.request('chat_transport')
    await clock.advance(2000)
    expect(supervisor.health().lastError).toContain('did not become ready within 1000ms')
    expect(supervisor.exhausted).toBe(false)

    supervisor.request('chat_transport')
    await clock.advance(3000)
    expect(supervisor.exhausted).toBe(true)
    expect(supervisor.attempts).toBe(2)
  })

  it('does not start after an abort lands while stop is awaiting', async () => {
    const clock = new FakeClock()
    const controller = new AbortController()
    const start = vi.fn()
    let release = (): void => {}
    const stopping = new Promise<void>((resolve) => {
      release = resolve
    })
    const chat: RestartableChatPort = {
      stop: () => stopping,
      start,
      started: () => false,
    }

    const restarting = restartChatSource({
      chat,
      clock,
      timeoutMs: 55_000,
      pollIntervalMs: 250,
      signal: controller.signal,
    })
    controller.abort()
    release()
    await restarting
    await flushMicrotasks()

    expect(start).not.toHaveBeenCalled()
    expect(clock.pendingTimerCount).toBe(0)
  })

  it('cancels an active readiness poll immediately when aborted', async () => {
    const clock = new FakeClock()
    const controller = new AbortController()
    const start = vi.fn()
    const chat: RestartableChatPort = {
      stop: () => Promise.resolve(),
      start,
      started: () => false,
    }

    const restarting = restartChatSource({
      chat,
      clock,
      timeoutMs: 55_000,
      pollIntervalMs: 250,
      signal: controller.signal,
    })
    await flushMicrotasks()
    expect(start).toHaveBeenCalledOnce()
    expect(clock.pendingTimerCount).toBe(1)

    controller.abort()
    await restarting

    expect(clock.pendingTimerCount).toBe(0)
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
