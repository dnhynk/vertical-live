import { describe, expect, it } from 'vitest'

import { loadInputConfig, parserLimits } from '../input/config.js'
import { CommandMetrics } from '../input/metrics.js'
import { parseMessage } from '../input/parse.js'
import { testChatConfig } from '../testing/chat-test-support.js'
import { FakeClock, flushMicrotasks } from '../testing/fake-clock.js'
import { buildChatHealthSignals } from '../youtube/chat/health.js'
import { ChatSourceState } from '../youtube/chat/state.js'
import { DELIVERED, type AlertSink } from './alerts.js'
import { DeadManMonitor } from './deadman.js'
import { AdminModerationEndpoint } from './moderation-report.js'
import { STARTUP_STEP_ORDER, type StartupStep, type StartupSteps } from './startup.js'
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

/** Synthetic; the real one lives in the vault and never in a test (§10.2). */
const ADMIN_TOKEN = 'synthetic-admin-token'

/**
 * Runs the evaluation loop the way production does — one pass every
 * `evaluateIntervalMs`, with fresh signals — for `totalMs` of fake time.
 *
 * A test that jumps a whole minute in one `advance()` instead gets a supervisor
 * that has not heard from itself in a minute: `coordinatorHeartbeatTimeoutMs` is
 * 15s, so the coordinator family degrades, the engine is restarted until its
 * budget is spent, and the run reaches `safe_stopped` for a reason the test was
 * not about. That is exactly what the first draft of the heuristic tests below
 * measured.
 */
async function tickFor(harness: SupervisorHarness, totalMs: number): Promise<void> {
  const step = harness.config.evaluateIntervalMs
  for (let elapsed = 0; elapsed < totalMs; elapsed += step) {
    await harness.clock.advance(step)
    harness.pushHealthy()
    await harness.supervisor.evaluate()
  }
}

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

    it('stops the run for an approved token from POST /admin/moderation (§T22)', async () => {
      // The whole T22 path in one test, on T12's own transition harness: a human
      // presses the endpoint, the endpoint hands the token to the supervisor, and
      // §12.3's two steps happen — CTA off, then `safe_stopped` because BOARD
      // D-13 put this token on the approved safe-stop list.
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)
      const endpoint = new AdminModerationEndpoint({
        token: ADMIN_TOKEN,
        clock: harness.clock,
        onReport: (report) => {
          harness.supervisor.reportModerationHealth('degraded', report.reason)
        },
        onClear: () => {
          harness.supervisor.reportModerationHealth('ok')
        },
      })

      const response = endpoint.report({
        authorization: `Bearer ${ADMIN_TOKEN}`,
        remoteAddress: '127.0.0.1',
        body: { reason: 'targeted_harassment', note: 'synthetic operator note' },
      })
      await flushMicrotasks()

      expect(response.status).toBe(202)
      expect(harness.inputHealth).toBe('degraded')
      expect(harness.supervisor.health().interactionEnabled).toBe(false)
      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(harness.supervisor.health().safeStop).toMatchObject({
        kind: 'moderation_unhealthy',
        reason: 'targeted_harassment',
      })
      // Both stages alert, in order and once each (review round 1, B1). Stage 1
      // is not skipped because stage 2 follows: §12.3 turns the CTA off and says
      // so, and only then does the approved token stop the run.
      const warnings = harness.alerts.ofKind('moderation.unhealthy')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.severity).toBe('warning')
      expect(warnings[0]?.reason).toBe('targeted_harassment')
      expect(warnings[0]?.detail['safeStopConditionMatched']).toBe(true)
      // One alert, not one per evaluation (spec §11 알림).
      const alerts = harness.alerts.ofKind('supervisor.safe_stopped')
      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.severity).toBe('critical')
      // …and the operator sees the warning first.
      const order = harness.alerts.alerts.map((alert) => alert.kind)
      expect(order.indexOf('moderation.unhealthy')).toBeLessThan(
        order.indexOf('supervisor.safe_stopped'),
      )
      // `/health` carries the token and the instant, and nothing an operator
      // typed (TASK_SPECS §T22: "토큰·시각만").
      const moderation = harness.supervisor.health().moderation
      expect(moderation).toMatchObject({
        status: 'degraded',
        reason: 'targeted_harassment',
        reportedAtUtc: harness.clock.nowUtcIso(),
      })
      expect(JSON.stringify(harness.supervisor.health())).not.toContain('synthetic operator note')
    })

    it('delivers the warning before the stop when the sink is slow (round 2, B1)', async () => {
      // The reviewer's round-2 reproduction, which the assertion above cannot
      // make: `RecordingAlertSink` pushes synchronously, before its promise
      // resolves, so an index comparison on its array holds even when the two
      // deliveries are concurrent. With a sink that blocks only the warning, the
      // critical one used to complete first —
      // `before_warning_release=["supervisor.safe_stopped"]`.
      const delivered: string[] = []
      let releaseWarning = (): void => {}
      const blocked = new Promise<void>((resolve) => {
        releaseWarning = resolve
      })
      const alerts: AlertSink = {
        name: 'delayed-warning',
        deliver: async (alert) => {
          if (alert.kind === 'moderation.unhealthy') await blocked
          delivered.push(alert.kind)
          return DELIVERED
        },
      }
      const harness = createSupervisorHarness({ preflight: passingPreflight(), alerts })
      await goLive(harness)
      const beforeReport = delivered.length

      harness.supervisor.reportModerationHealth('degraded', 'targeted_harassment')
      await flushMicrotasks()

      // Stopping does not wait for the telling (spec §9.1, §9.2): the state, the
      // trigger and the CTA are already where they belong while the sink is
      // still holding the warning.
      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(harness.supervisor.health().safeStop).toMatchObject({
        kind: 'moderation_unhealthy',
        reason: 'targeted_harassment',
      })
      expect(harness.supervisor.health().interactionEnabled).toBe(false)
      expect(harness.inputHealth).toBe('degraded')
      // …and nothing was delivered ahead of the warning that is still blocked.
      expect(delivered.slice(beforeReport)).toEqual([])

      releaseWarning()
      await flushMicrotasks()

      expect(delivered.slice(beforeReport)).toEqual([
        'moderation.unhealthy',
        'supervisor.safe_stopped',
      ])
    })

    it('lets a stuck sink time out instead of holding the stop alert (§T22)', async () => {
      // The queue must not become a new way to lose the critical alert: a
      // delivery that outlives `alerts.deliveryTimeoutMs` stops holding the ones
      // behind it, so the stop still reaches a human.
      const delivered: string[] = []
      const wedged = new Promise<void>(() => {
        // Never resolves on purpose: the transport is wedged, not slow.
      })
      const alerts: AlertSink = {
        name: 'wedged-warning',
        deliver: async (alert) => {
          if (alert.kind === 'moderation.unhealthy') await wedged
          delivered.push(alert.kind)
          return DELIVERED
        },
      }
      const harness = createSupervisorHarness({ preflight: passingPreflight(), alerts })
      await goLive(harness)

      harness.supervisor.reportModerationHealth('degraded', 'targeted_harassment')
      await flushMicrotasks()
      expect(delivered).not.toContain('supervisor.safe_stopped')

      await harness.clock.advance(harness.config.alerts.deliveryTimeoutMs)

      expect(delivered).toContain('supervisor.safe_stopped')
      expect(delivered).not.toContain('moderation.unhealthy')
    })

    it('turns the CTA back on when a report is cleared (§T22)', async () => {
      // A reason the Gate 0 table does not list: the CTA goes off, the run keeps
      // going, and `/admin/moderation/clear` puts it back.
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      await goLive(harness)

      harness.supervisor.reportModerationHealth('degraded', 'block_control_unavailable')
      await harness.clock.advance(1000)
      harness.pushHealthy()
      await harness.supervisor.evaluate()
      expect(harness.inputHealth).toBe('degraded')
      expect(harness.supervisor.health().moderation.reportedAtUtc).not.toBeNull()

      harness.supervisor.reportModerationHealth('ok')
      await harness.clock.advance(1000)
      harness.pushHealthy()
      await harness.supervisor.evaluate()

      expect(harness.inputHealth).toBe('ok')
      expect(harness.supervisor.state).toBe('live')
      expect(harness.supervisor.health().moderation).toMatchObject({
        status: 'ok',
        reason: null,
        reportedAtUtc: null,
      })
    })

    it('stops the run when the filter-evasion heuristic reports (§12.3, §T22)', async () => {
      // Same two steps, reached by the automatic reporter instead of a person.
      // The counters are driven through the real parser so the codes being
      // counted are the ones T6 actually produces.
      const metrics = new CommandMetrics()
      const limits = parserLimits(loadInputConfig({ env: {} }))
      const harness = createSupervisorHarness({
        preflight: passingPreflight(),
        commandMetrics: () => metrics.snapshot(),
      })
      await goLive(harness)
      const { windowMs, enterWindows } = harness.config.moderation.heuristics.filterEvasion
      const flood = (): void => {
        for (let index = 0; index < 30; index += 1) {
          metrics.recordParse(
            parseMessage(
              'feed example(dot)invalid',
              { identityGateOpen: false, voteWindowOpen: false },
              limits,
            ),
          )
        }
      }

      for (let window = 0; window < enterWindows; window += 1) {
        flood()
        await tickFor(harness, windowMs)
      }
      await flushMicrotasks()

      expect(harness.supervisor.health().moderation).toMatchObject({
        status: 'degraded',
        reason: 'filter_evasion_surge',
      })
      expect(harness.supervisor.health().moderation.filterEvasion.reported).toBe(true)
      expect(harness.inputHealth).toBe('degraded')
      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(harness.alerts.ofKind('supervisor.safe_stopped')).toHaveLength(1)
    })

    it('leaves an ordinary chat alone however long it runs (§T22 오탐 없음)', async () => {
      const metrics = new CommandMetrics()
      const limits = parserLimits(loadInputConfig({ env: {} }))
      const harness = createSupervisorHarness({
        preflight: passingPreflight(),
        commandMetrics: () => metrics.snapshot(),
      })
      await goLive(harness)
      const { windowMs } = harness.config.moderation.heuristics.filterEvasion

      for (let window = 0; window < 10; window += 1) {
        for (let index = 0; index < 30; index += 1) {
          metrics.recordParse(
            parseMessage('feed', { identityGateOpen: false, voteWindowOpen: false }, limits),
          )
        }
        await tickFor(harness, windowMs)
      }

      expect(harness.supervisor.state).toBe('live')
      expect(harness.supervisor.health().moderation.status).toBe('ok')
      expect(harness.supervisor.health().moderation.filterEvasion.windowsClosed).toBe(10)
      expect(harness.inputHealth).toBe('ok')
    })

    it('reports no detector at all when nothing in the process parses chat', () => {
      const harness = createSupervisorHarness()

      expect(harness.supervisor.health().moderation.filterEvasion).toMatchObject({
        enabled: false,
        windowsClosed: 0,
        lastWindow: null,
      })
    })

    it('will not go live for an idle chat source that only reports bookkeeping (round 2)', async () => {
      // The reviewer's reproduction: not *absent* signals — a real idle
      // `ChatSourceState`, which reports `transport=unknown:not_started`,
      // `keepalive=unknown:no_grpc_channel`, and `reconnect`/`user_events=ok`.
      // Round 1 folded those together and the run went live with the CTA on.
      const harness = createSupervisorHarness({ preflight: passingPreflight() })
      const chatNames = [
        'youtube.chat.transport',
        'youtube.chat.keepalive',
        'youtube.chat.reconnect',
        'youtube.chat.user_events',
      ]
      const pushIdleChat = (): void => {
        harness.pushHealthy(chatNames)
        const state = new ChatSourceState(harness.clock, testChatConfig().grpc.keepalive)
        for (const item of buildChatHealthSignals(state.observe(null, null), harness.clock)) {
          harness.push(item)
        }
      }

      pushIdleChat()
      await harness.supervisor.start()

      expect(harness.supervisor.state).not.toBe('live')
      expect(harness.inputHealth).toBe('degraded')
      expect(harness.supervisor.health().interactionEnabled).toBe(false)
      expect(harness.supervisor.aggregate?.families.chat_transport.status).toBe('unknown')
      expect(harness.supervisor.aggregate?.requiredNotOk).toContain('chat_transport')

      // A source that really connects — on either path — lifts it.
      await harness.clock.advance(1000)
      harness.pushHealthy(chatNames)
      const connected = new ChatSourceState(harness.clock, testChatConfig().grpc.keepalive)
      connected.setMode('rest')
      connected.recordResponse()
      for (const item of buildChatHealthSignals(connected.observe(null, null), harness.clock)) {
        harness.push(item)
      }
      await harness.supervisor.evaluate()

      expect(harness.supervisor.state).toBe('live')
      expect(harness.inputHealth).toBe('ok')
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
      // The stop itself is synchronous; `onSafeStop` runs after the alert, and
      // alerts are delivered in order off a queue now (round 2, B1).
      await flushMicrotasks()

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

    it('abandons the start-up sequence when a kill lands mid-step (review round 3)', async () => {
      // The HTTP surface listens before `supervisor.start()` runs, so a kill can
      // arrive while the sequence is awaiting YouTube or OBS. The reviewer's
      // reproduction: block `broadcast`, stop the run, release it — everything
      // after must not run, and the dead-man/screenshot loops must not start.
      const calls: string[] = []
      let releaseBroadcast = (): void => {}
      const broadcasting = new Promise<void>((resolve) => {
        releaseBroadcast = resolve
      })
      const step = (name: StartupStep) => async (): Promise<void> => {
        calls.push(name)
        if (name === 'broadcast') await broadcasting
      }
      const steps = Object.fromEntries(
        STARTUP_STEP_ORDER.map((name) => [name, step(name)]),
      ) as unknown as StartupSteps

      const clock = new FakeClock()
      const deadMan = new DeadManMonitor({
        pushUrl: () => Promise.resolve('https://kuma.example/api/push/synthetic'),
        config: { enabled: true, intervalMs: 60_000, requestTimeoutMs: 1000 },
        clock,
        fetchImpl: (() =>
          Promise.reject(new Error('must not be called'))) as unknown as typeof fetch,
      })
      const harness = createSupervisorHarness({
        preflight: passingPreflight(),
        startup: steps,
        deadMan,
      })
      harness.pushHealthy()

      const starting = harness.supervisor.start()
      await flushMicrotasks()
      expect(calls).toEqual(['db', 'engine', 'retention', 'broadcast'])

      harness.supervisor.onKillSwitch({
        source: 'http',
        reason: 'operator',
        at: harness.clock.nowUtcIso(),
      })
      await flushMicrotasks()
      releaseBroadcast()
      await starting

      // Nothing after the in-flight step ran: no stream key injection, no
      // encoder start, no go-live, no listener, no publication.
      expect(calls).toEqual(['db', 'engine', 'retention', 'broadcast'])
      expect(harness.supervisor.state).toBe('safe_stopped')
      expect(deadMan.running).toBe(false)

      const result = harness.supervisor.startupResult
      expect(result?.aborted).toBe(true)
      expect(result?.completed).toBe(false)
      // A cancelled sequence is not a failed one: it spends no retry and raises
      // no start-up failure alert.
      expect(result?.failedStep).toBeNull()
      expect(harness.alerts.ofKind('supervisor.startup_failed')).toHaveLength(0)
      expect(
        result?.steps.filter((entry) => entry.status === 'cancelled').map((entry) => entry.step),
      ).toEqual(['broadcast', 'streamService', 'startStream', 'goLive', 'chatSource', 'publish'])
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

    it('halts before it reports, so a blocked alert cannot let a restart finish (round 4)', async () => {
      // The reviewer's production-path probe. The chat restart is two-phase —
      // `await stop()` then `start()` — and the safe-stop alert is a webhook that
      // can take seconds or time out. Round 3 aborted in-flight actions, but the
      // abort happened *after* awaiting that alert, so the listener still came
      // back up: observed `["stop-began","safe-stop-alert-began","start-after-stop"]`.
      const order: string[] = []
      let releaseStop = (): void => {}
      const stopping = new Promise<void>((resolve) => {
        releaseStop = resolve
      })
      let releaseAlert = (): void => {}
      const alerting = new Promise<void>((resolve) => {
        releaseAlert = resolve
      })

      const alerts: AlertSink = {
        name: 'blocking',
        deliver: async (alert) => {
          if (alert.kind !== 'supervisor.safe_stopped') return DELIVERED
          order.push('safe-stop-alert-began')
          await alerting
          order.push('safe-stop-alert-delivered')
          return DELIVERED
        },
      }

      const harness = createSupervisorHarness({
        preflight: passingPreflight(),
        alerts,
        actions: {
          // The shape `main.ts` really uses for the chat source.
          chatSource: async (signal) => {
            order.push('stop-began')
            await stopping
            if (signal.aborted) return
            order.push('start-after-stop')
          },
        },
      })
      await goLive(harness)

      // Put the chat restart in flight: degrade the transport, let the attempt
      // be scheduled, and advance past its backoff so the action is awaiting.
      await harness.clock.advance(1000)
      harness.pushHealthy(['youtube.chat.transport'])
      harness.push(
        signal('youtube.chat.transport', 'degraded', {
          component: 'youtube-chat',
          reason: 'retry_budget_exhausted',
          at: harness.clock.nowUtcIso(),
          monotonicMs: harness.clock.monotonicMs(),
        }),
      )
      await harness.supervisor.evaluate()
      await harness.clock.advance(harness.config.restart.initialDelayMs)
      expect(order).toEqual(['stop-began'])

      // The real request path. It must have halted everything by the time it
      // returns control, even though the alert is still blocked.
      const stopping2 = harness.supervisor.requestSafeStop({
        kind: 'rights_or_policy',
        at: harness.clock.nowUtcIso(),
        reason: 'rights_claim',
        detail: {},
      })
      await flushMicrotasks()
      expect(order).toEqual(['stop-began', 'safe-stop-alert-began'])

      // Release the action's awaited `stop()` while the alert is still in flight.
      releaseStop()
      await flushMicrotasks()
      expect(order).toEqual(['stop-began', 'safe-stop-alert-began'])

      releaseAlert()
      await stopping2

      expect(order).toEqual(['stop-began', 'safe-stop-alert-began', 'safe-stop-alert-delivered'])
      expect(harness.supervisor.state).toBe('safe_stopped')
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

    it('puts what a restart action recorded on the health document (BOARD D-7)', () => {
      // How the OBS launcher's crash-sentinel count reaches `/health`: the
      // `obs-process` action in `main.ts` calls this after `launch()` returns.
      const harness = createSupervisorHarness()

      harness.supervisor.noteComponent('obs-process', 'sentinel_cleared=1')

      const obsProcess = harness.supervisor
        .health()
        .components.find((entry) => entry.component === 'obs-process')
      expect(obsProcess?.lastNote).toBe('sentinel_cleared=1')
      // It belongs to that component only; nothing else grows a note.
      expect(
        harness.supervisor
          .health()
          .components.filter((entry) => entry.lastNote !== null)
          .map((entry) => entry.component),
      ).toEqual(['obs-process'])
    })

    it('gives every component an attempt budget so exhaustion can happen', () => {
      const harness = createSupervisorHarness()

      for (const entry of harness.supervisor.components()) {
        expect(entry.maxAttempts).toBeGreaterThan(0)
      }
    })
  })

  describe('retention and revocation reporting (TASK_SPECS §T12 배선)', () => {
    it('alerts on a sweep that was not clean or left rows unprocessed', async () => {
      const harness = createSupervisorHarness()

      harness.supervisor.onRetentionResult({ clean: true, rowsUnprocessed: 0 })
      await flushMicrotasks()
      expect(harness.alerts.alerts).toHaveLength(0)

      harness.supervisor.onRetentionResult({ clean: false, rowsUnprocessed: 0 })
      harness.supervisor.onRetentionResult({ clean: true, rowsUnprocessed: 4 })
      // Delivery is queued, so it is one microtask away rather than immediate
      // (round 2, B1) — the order it arrives in is the order it was raised in.
      await flushMicrotasks()

      expect(harness.alerts.ofKind('retention.sweep_incomplete')).toHaveLength(2)
    })

    it('alerts when a revocation misses its deadline (spec §12.4)', async () => {
      const harness = createSupervisorHarness()

      harness.supervisor.onRevocationResult({
        withinDeadline: false,
        incomplete: ['inbox.envelope'],
        reason: 'invalid_grant',
      })
      await flushMicrotasks()

      const alert = harness.alerts.ofKind('privacy.revocation_incomplete')[0]
      expect(alert?.severity).toBe('critical')
      expect(alert?.reason).toBe('deadline_missed')
    })
  })
})
