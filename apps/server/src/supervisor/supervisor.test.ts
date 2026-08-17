import { describe, expect, it } from 'vitest'

import { SUPERVISED_COMPONENTS } from './types.js'
import {
  BASE_ENGINE_HEALTH,
  createSupervisorHarness,
  passingPreflight,
  signal,
  type SupervisorHarness,
} from './testing/harness.js'

/**
 * The supervisor end to end (TASK_SPECS §T12 acceptance 1 and 3): signal
 * combinations move the state machine, the CTA follows the input path, recovery
 * is driven by exactly one supervisor per component, and a policy stop is never
 * restarted.
 */

async function goLive(harness: SupervisorHarness): Promise<void> {
  harness.pushHealthy()
  await harness.supervisor.start()
  expect(harness.supervisor.state).toBe('live')
}

const OBS_OUTPUT_SIGNALS = ['obs.stream', 'obs.output_progress'] as const

/**
 * OBS answering nothing at all: every one of its signals is `unknown`, held
 * there past `unobservableGraceMs`, which is when an encoder nobody can reach
 * stops being "quiet" and becomes a fault (spec §9.2).
 */
async function unreachableObs(harness: SupervisorHarness): Promise<void> {
  const push = (): void => {
    harness.pushHealthy(OBS_OUTPUT_SIGNALS)
    for (const name of OBS_OUTPUT_SIGNALS) {
      harness.push(
        signal(name, 'unknown', {
          reason: 'obs_not_connected',
          at: harness.clock.nowUtcIso(),
          monotonicMs: harness.clock.monotonicMs(),
        }),
      )
    }
  }

  await harness.clock.advance(1000)
  push()
  await harness.supervisor.evaluate()

  // Re-reported all the way through the grace, so the escalation is about the
  // family staying unobservable rather than about a report going stale.
  const step = Math.max(1, Math.floor(harness.config.unobservableGraceMs / 4))
  for (let elapsed = 0; elapsed <= harness.config.unobservableGraceMs; elapsed += step) {
    await harness.clock.advance(step)
    push()
    await harness.supervisor.evaluate()
  }
}

describe('supervisor state machine', () => {
  it('starts offline, runs the pre-checks and goes live', async () => {
    const harness = createSupervisorHarness({ preflight: passingPreflight() })
    expect(harness.supervisor.state).toBe('offline')

    await goLive(harness)

    expect(harness.supervisor.health().preflight.map((check) => check.check)).toEqual([
      'credentials',
      'secrets',
      'state',
      'api',
      'renderer',
      'encoder',
    ])
  })

  it('stays in starting while a pre-check fails, and says which one', async () => {
    const harness = createSupervisorHarness({
      preflight: {
        ...passingPreflight(),
        encoder: () => ({ passed: false, reason: 'obs_not_connected' }),
      },
    })
    harness.pushHealthy()
    await harness.supervisor.start()

    expect(harness.supervisor.state).toBe('starting')
    const failed = harness.supervisor.health().preflight.find((check) => !check.passed)
    expect(failed?.check).toBe('encoder')
    expect(failed?.reason).toBe('obs_not_connected')
    expect(harness.alerts.ofKind('supervisor.preflight_failed')).toHaveLength(1)
  })

  it('re-reads a failing pre-check and leaves starting when it passes (review round 1, M1)', async () => {
    // §9.1 자동 복구: a renderer that attaches after boot, an encoder that
    // finishes starting, an API that comes back. Round 1 found the first
    // preflight result cached forever, so the machine stayed in `starting`.
    let rendererAttached = false
    const harness = createSupervisorHarness({
      preflight: {
        ...passingPreflight(),
        renderer: () =>
          rendererAttached ? { passed: true } : { passed: false, reason: 'no_renderer_attached' },
      },
    })

    harness.pushHealthy()
    await harness.supervisor.start()
    expect(harness.supervisor.state).toBe('starting')

    rendererAttached = true
    // Before the retry interval nothing is re-read, so the state does not flap.
    await harness.clock.advance(Math.floor(harness.config.preflightRetryIntervalMs / 2))
    harness.pushHealthy()
    await harness.supervisor.evaluate()
    expect(harness.supervisor.state).toBe('starting')

    await harness.clock.advance(harness.config.preflightRetryIntervalMs)
    harness.pushHealthy()
    await harness.supervisor.evaluate()

    expect(harness.supervisor.state).toBe('live')
    expect(harness.supervisor.health().preflight.every((check) => check.passed)).toBe(true)
  })

  it('goes to safe_stopped when a pre-check reports a rights or account problem', async () => {
    const harness = createSupervisorHarness({
      preflight: {
        ...passingPreflight(),
        credentials: () => ({
          passed: false,
          reason: 'grant_revoked',
          safeStop: 'account_action' as const,
        }),
      },
    })
    harness.pushHealthy()
    await harness.supervisor.start()

    expect(harness.supervisor.state).toBe('safe_stopped')
    expect(harness.supervisor.health().safeStop?.kind).toBe('account_action')
  })

  describe('degraded windows (spec §9.2)', () => {
    it('turns the CTA off when the input path is unhealthy and back on when it recovers', async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)
      expect(harness.inputHealth).toBe('ok')

      await harness.clock.advance(1000)
      harness.pushHealthy()
      harness.push(
        signal('youtube.chat.transport', 'degraded', {
          component: 'youtube-chat',
          reason: 'retry_budget_exhausted',
          at: harness.clock.nowUtcIso(),
          monotonicMs: harness.clock.monotonicMs(),
        }),
      )
      await harness.supervisor.evaluate()

      expect(harness.supervisor.state).toBe('degraded')
      // The engine owns `interactionEnabled`; the supervisor instructs it.
      expect(harness.inputHealth).toBe('degraded')
      expect(harness.supervisor.health().interactionEnabled).toBe(false)

      await harness.clock.advance(1000)
      harness.pushHealthy()
      await harness.supervisor.evaluate()

      expect(harness.supervisor.state).toBe('live')
      expect(harness.inputHealth).toBe('ok')
    })

    it('turns the CTA off when the moderation control is unhealthy (spec §12.3)', async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      harness.supervisor.reportModerationHealth('degraded', 'block_control_unavailable')
      await harness.clock.advance(1000)
      harness.pushHealthy()
      await harness.supervisor.evaluate()

      expect(harness.inputHealth).toBe('degraded')
      // Round 1 (M2): turning the CTA off silently is not enough — an unhealthy
      // moderation control is a human-callable condition (§12.3).
      const alert = harness.alerts.ofKind('moderation.unhealthy')[0]
      expect(alert?.severity).toBe('warning')
      expect(alert?.reason).toBe('block_control_unavailable')
      expect(alert?.detail['safeStopConditionMatched']).toBe(false)
      expect(harness.supervisor.state).not.toBe('safe_stopped')
    })

    it('stops the run when a reported condition is on the approved call table (§12.3)', async () => {
      const base = createSupervisorHarness().config
      const harness = createSupervisorHarness({
        preflight: passingPreflight(),
        config: {
          ...base,
          moderation: {
            ...base.moderation,
            approved: true,
            onCallOwner: 'operations',
            maxResponseMinutes: 30,
            escalationChannel: 'discord',
            autoBlockScope: 'youtube blocked words + URL hold',
            safeStopConditions: ['block_control_unavailable'],
          },
        },
      })
      await goLive(harness)

      harness.supervisor.reportModerationHealth('degraded', 'block_control_unavailable')
      await harness.supervisor.evaluate()

      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(harness.supervisor.health().safeStop?.kind).toBe('moderation_unhealthy')
      expect(harness.inputHealth).toBe('degraded')
    })

    it('will not go live while the chat producer is absent (review round 1, B2)', async () => {
      // Not the §9.4(3) silence case: T9 reports `user_events=ok` throughout a
      // quiet chat. This is the transport producer missing altogether, which
      // §9.2's `live` definition does not allow.
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      const chatSignals = ['youtube.chat.transport', 'youtube.chat.keepalive'] as const

      harness.pushHealthy([...chatSignals, 'youtube.chat.reconnect', 'youtube.chat.user_events'])
      await harness.supervisor.start()

      expect(harness.supervisor.state).not.toBe('live')
      expect(harness.inputHealth).toBe('degraded')
      expect(harness.supervisor.health().interactionEnabled).toBe(false)

      // Held there past the grace, the absence becomes a degraded family rather
      // than an open question.
      const step = Math.floor(harness.config.unobservableGraceMs / 4)
      for (let elapsed = 0; elapsed <= harness.config.unobservableGraceMs; elapsed += step) {
        await harness.clock.advance(step)
        harness.pushHealthy([...chatSignals, 'youtube.chat.reconnect', 'youtube.chat.user_events'])
        await harness.supervisor.evaluate()
      }

      expect(harness.supervisor.state).toBe('degraded')
      expect(harness.supervisor.aggregate?.degradedFamilies).toContain('chat_transport')

      // The producer appears: the run goes live and the CTA comes back.
      await harness.clock.advance(1000)
      harness.pushHealthy()
      await harness.supervisor.evaluate()

      expect(harness.supervisor.state).toBe('live')
      expect(harness.inputHealth).toBe('ok')
    })

    it('keeps the CTA on while the chat is merely silent', async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      await harness.clock.advance(1000)
      harness.pushHealthy()
      harness.push(
        signal('youtube.chat.user_events', 'ok', {
          component: 'youtube-chat',
          at: harness.clock.nowUtcIso(),
          monotonicMs: harness.clock.monotonicMs(),
        }),
      )
      await harness.supervisor.evaluate()

      expect(harness.supervisor.state).toBe('live')
      expect(harness.inputHealth).toBe('ok')
    })
  })

  describe('recovery (spec §9.2, §10.2)', () => {
    it('asks the responsible component and reports recovering while it acts', async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      await harness.clock.advance(1000)
      harness.pushHealthy()
      harness.push(
        signal('obs.stream', 'degraded', {
          reason: 'output_inactive',
          at: harness.clock.nowUtcIso(),
          monotonicMs: harness.clock.monotonicMs(),
        }),
      )
      await harness.supervisor.evaluate()

      expect(harness.supervisor.state).toBe('degraded')
      // The attempt is scheduled with backoff; the next evaluation sees it.
      await harness.supervisor.evaluate()
      expect(harness.supervisor.state).toBe('recovering')

      await harness.clock.advance(harness.config.restart.initialDelayMs)
      expect(harness.restarts).toEqual(['obs-stream'])

      await harness.clock.advance(1000)
      harness.pushHealthy()
      await harness.supervisor.evaluate()
      expect(harness.supervisor.state).toBe('live')
    })

    it("never dials OBS itself: the connection loop stays ObsClient's (spec §10.2)", async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      harness.obsConnectionAttempts = 1
      await unreachableObs(harness)

      const obsConnection = harness.supervisor
        .components()
        .find((component) => component.component === 'obs-connection')
      expect(obsConnection?.owner).toBe('obs.ObsClient')
      expect(obsConnection?.attempts).toBe(1)
      expect(harness.restarts).not.toContain('obs-connection')
    })

    it('escalates to the OBS process when the connection loop has retried past its budget', async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      harness.obsConnectionAttempts = harness.config.restart.maxAttempts['obs-connection']
      await unreachableObs(harness)
      await harness.clock.advance(harness.config.restart.initialDelayMs)

      expect(harness.restarts).toContain('obs-process')
      expect(harness.alerts.ofKind('supervisor.restart_escalated')).toHaveLength(1)
    })

    it('lets the escalation target spend its whole budget and then stops (review round 1, B3)', async () => {
      // Round 1 found the escalation firing once and then being handed its
      // budget back on every later pass, so the T17 placeholder failure never
      // reached `safe_stopped`. The target now keeps the work while the
      // condition lasts.
      const harness = createSupervisorHarness({
        preflight: passingPreflight(),
        restartDelayMs: 500,
      })
      await goLive(harness)
      harness.failing.add('obs-process')

      harness.obsConnectionAttempts = harness.config.restart.maxAttempts['obs-connection']
      await unreachableObs(harness)

      const budget = harness.config.restart.maxAttempts['obs-process']
      for (let attempt = 0; attempt < budget; attempt += 1) {
        await harness.clock.advance(500)
        await harness.supervisor.evaluate()
      }

      const process = harness.supervisor
        .components()
        .find((component) => component.component === 'obs-process')
      expect(harness.restarts.filter((component) => component === 'obs-process')).toHaveLength(
        budget,
      )
      expect(process?.attempts).toBe(budget)
      expect(process?.exhausted).toBe(true)
      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(harness.supervisor.health().safeStop?.reason).toContain('obs-process')
    })

    it('stops for good once a component has spent its attempts (spec §9.2)', async () => {
      const harness = createSupervisorHarness({
        preflight: passingPreflight(),
        restartDelayMs: 500,
      })
      await goLive(harness)
      harness.failing.add('renderer-source')

      const budget = harness.config.restart.maxAttempts['renderer-source']
      for (let attempt = 0; attempt < budget; attempt += 1) {
        await harness.clock.advance(500)
        harness.engine = {
          ...BASE_ENGINE_HEALTH,
          lastCommittedAt: harness.clock.nowUtcIso(),
          rendererCount: 0,
          degraded: true,
          degradedReasons: ['no_renderer'],
        }
        harness.pushHealthy()
        await harness.supervisor.evaluate()
        await harness.clock.advance(500)
      }

      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(harness.supervisor.health().safeStop?.kind).toBe('restart_budget_exhausted')
      const critical = harness.alerts.alerts.filter((alert) => alert.severity === 'critical')
      expect(critical.some((alert) => alert.kind === 'supervisor.safe_stopped')).toBe(true)
    })
  })

  describe('safe_stopped (spec §9.1, §9.2, §12.3)', () => {
    it('stops on a rights or policy request from the broadcast lifecycle', async () => {
      let stopped = 0
      const harness = createSupervisorHarness({
        preflight: passingPreflight(),
        onSafeStop: () => {
          stopped += 1
        },
      })
      await goLive(harness)

      harness.supervisor.onBroadcastSafeStopRequest({
        at: harness.clock.nowUtcIso(),
        reason: 'broadcast_limit_unrecoverable',
        detail: { kind: 'userBroadcastsExceedLimit' },
      })
      await harness.supervisor.evaluate()

      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(stopped).toBe(1)
    })

    it('stops when the grant is revoked and never restarts by itself', async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      harness.supervisor.onAuthEvent({
        type: 'auth_revoked',
        at: harness.clock.nowUtcIso(),
        reason: 'invalid_grant',
      })
      await harness.supervisor.evaluate()
      expect(harness.supervisor.state).toBe('safe_stopped')

      // Everything healthy again, several evaluations later: still stopped, and
      // no component was restarted (spec §9.1 — re-entry is a human decision).
      const restartsBefore = harness.restarts.length
      for (let tick = 0; tick < 3; tick += 1) {
        await harness.clock.advance(5000)
        harness.pushHealthy()
        await harness.supervisor.evaluate()
      }

      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(harness.restarts).toHaveLength(restartsBefore)
    })

    it('stops on any of the three kill-switch paths', async () => {
      for (const source of ['http', 'file', 'cli'] as const) {
        const harness = createSupervisorHarness({ preflight: passingPreflight() })
        await goLive(harness)

        harness.supervisor.onKillSwitch({
          source,
          reason: 'operator',
          at: harness.clock.nowUtcIso(),
        })
        await harness.supervisor.evaluate()

        expect(harness.supervisor.state).toBe('safe_stopped')
        expect(harness.supervisor.health().safeStop?.kind).toBe('kill_switch')
        expect(harness.supervisor.health().safeStop?.detail['source']).toBe(source)
      }
    })

    it('cancels a restart that was already scheduled (review round 1, B1)', async () => {
      // The reproduction from the review: schedule `obs-stream`, stop the run
      // for a rights reason before the backoff elapses, then let the clock run
      // past it. In production that action is `ObsControl.startStream()`, so a
      // restart here would push video after the safe-stop handler stopped it.
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      await harness.clock.advance(1000)
      harness.pushHealthy(['obs.stream'])
      harness.push(
        signal('obs.stream', 'degraded', {
          reason: 'output_inactive',
          at: harness.clock.nowUtcIso(),
          monotonicMs: harness.clock.monotonicMs(),
        }),
      )
      await harness.supervisor.evaluate()
      expect(
        harness.supervisor.components().find((entry) => entry.component === 'obs-stream')?.inFlight,
      ).toBe(true)

      harness.supervisor.onBroadcastSafeStopRequest({
        at: harness.clock.nowUtcIso(),
        reason: 'rights_claim',
        detail: {},
      })
      await harness.supervisor.evaluate()
      expect(harness.supervisor.state).toBe('safe_stopped')

      await harness.clock.advance(harness.config.restart.maxDelayMs * 2)

      expect(harness.restarts).toEqual([])
      expect(harness.supervisor.components().every((entry) => !entry.inFlight)).toBe(true)
    })

    it('reports the first trigger, not the last', async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      harness.supervisor.onKillSwitch({
        source: 'file',
        reason: 'first',
        at: harness.clock.nowUtcIso(),
      })
      await harness.supervisor.evaluate()
      harness.supervisor.onBroadcastSafeStopRequest({
        at: harness.clock.nowUtcIso(),
        reason: 'second',
        detail: {},
      })
      await harness.supervisor.evaluate()

      expect(harness.supervisor.health().safeStop?.reason).toBe('first')
    })
  })

  describe('structure (spec §10.2)', () => {
    it('registers exactly one restart supervisor per component', async () => {
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      const components = harness.supervisor.components().map((entry) => entry.component)

      expect([...components].sort()).toEqual([...SUPERVISED_COMPONENTS].sort())
      expect(new Set(components).size).toBe(components.length)
      expect(() => harness.supervisor.registry.assertComplete()).not.toThrow()
      await Promise.resolve()
    })

    it('gives every component an attempt budget so exhaustion can happen', () => {
      const harness = createSupervisorHarness()

      for (const entry of harness.supervisor.components()) {
        expect(entry.maxAttempts).toBeGreaterThan(0)
      }
    })
  })

  describe('retention and revocation reporting (TASK_SPECS §T12 배선)', () => {
    it('alerts on a sweep that was not clean or left rows unprocessed', () => {
      const harness = createSupervisorHarness()

      harness.supervisor.onRetentionResult({ clean: true, rowsUnprocessed: 0 })
      expect(harness.alerts.alerts).toHaveLength(0)

      harness.supervisor.onRetentionResult({ clean: false, rowsUnprocessed: 0 })
      harness.supervisor.onRetentionResult({ clean: true, rowsUnprocessed: 4 })

      expect(harness.alerts.ofKind('retention.sweep_incomplete')).toHaveLength(2)
    })

    it('alerts when a revocation misses its deadline (spec §12.4)', () => {
      const harness = createSupervisorHarness()

      harness.supervisor.onRevocationResult({
        withinDeadline: false,
        incomplete: ['inbox.envelope'],
        reason: 'invalid_grant',
      })

      const alert = harness.alerts.ofKind('privacy.revocation_incomplete')[0]
      expect(alert?.severity).toBe('critical')
      expect(alert?.reason).toBe('deadline_missed')
    })
  })
})
