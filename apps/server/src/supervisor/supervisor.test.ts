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
