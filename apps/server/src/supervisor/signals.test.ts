import { describe, expect, it } from 'vitest'

import { OBS_HEALTH_SIGNAL_NAMES } from '../obs/health.js'
import { FakeClock } from '../testing/fake-clock.js'
import { YOUTUBE_BROADCAST_HEALTH_SIGNAL_NAMES } from '../youtube/broadcast/health.js'
import { CHAT_HEALTH_SIGNAL_NAMES } from '../youtube/chat/health.js'
import { loadSupervisorConfig } from './config.js'
import { HealthAggregator, MODERATION_HEALTHY, type AggregatorReadings } from './signals.js'
import { BASE_ENGINE_HEALTH, HEALTHY_RENDERER, healthySignals, signal } from './testing/harness.js'
import { HEALTH_FAMILIES, type DeadManStatus } from './types.js'

/**
 * The one aggregator of spec §9.4. Its job is to say what the reports *say*;
 * every test here is about that boundary, not about what the state machine does
 * with the answer.
 */

const DEAD_MAN_OFF: DeadManStatus = {
  enabled: false,
  lastPushAt: null,
  lastPushOk: null,
  consecutiveFailures: 0,
  lastError: null,
}

function readings(overrides: Partial<AggregatorReadings> = {}): AggregatorReadings {
  return {
    engine: BASE_ENGINE_HEALTH,
    renderer: HEALTHY_RENDERER,
    deadMan: DEAD_MAN_OFF,
    moderation: MODERATION_HEALTHY,
    lastEvaluationMonotonicMs: null,
    nowUtc: '2026-01-01T00:00:00.000Z',
    nowMonotonicMs: 0,
    ...overrides,
  }
}

describe('health aggregator (spec §9.4)', () => {
  const config = loadSupervisorConfig()

  it('maps every signal the producers export to one of the eight families', () => {
    // The completeness check that keeps a new producer from becoming an
    // invisible hole in §9.4 coverage.
    const aggregator = new HealthAggregator(config)
    const names = [
      ...OBS_HEALTH_SIGNAL_NAMES,
      ...YOUTUBE_BROADCAST_HEALTH_SIGNAL_NAMES,
      ...CHAT_HEALTH_SIGNAL_NAMES,
    ]
    for (const name of names) aggregator.report(signal(name, 'ok'))

    expect(aggregator.evaluate(readings()).unmappedSignals).toEqual([])
    expect(aggregator.signals()).toHaveLength(names.length)
  })

  it('reports an unmapped signal instead of dropping it', () => {
    const aggregator = new HealthAggregator(config)
    aggregator.report(signal('some.future.producer', 'ok'))

    expect(aggregator.evaluate(readings()).unmappedSignals).toEqual(['some.future.producer'])
  })

  it('answers ok for all eight families when every producer is happy', () => {
    const aggregator = new HealthAggregator(config)
    for (const item of healthySignals()) aggregator.report(item)

    const result = aggregator.evaluate(readings())

    expect(result.degradedFamilies).toEqual([])
    // Only the dead-man family is unknown: it is disabled in the default config.
    expect(result.unknownFamilies).toEqual(['dead_man'])
    for (const family of HEALTH_FAMILIES) {
      expect(result.families[family].family).toBe(family)
    }
  })

  it('takes one degraded producer as the family verdict', () => {
    const aggregator = new HealthAggregator(config)
    for (const item of healthySignals()) aggregator.report(item)
    aggregator.report(signal('obs.stream', 'degraded', { reason: 'output_inactive' }))

    const result = aggregator.evaluate(readings())

    expect(result.degradedFamilies).toEqual(['obs_output'])
    expect(result.families.obs_output.reason).toBe('output_inactive')
    expect(result.families.obs_output.sources).toEqual(['obs.stream'])
  })

  it('stops counting a report nobody refreshed', () => {
    const aggregator = new HealthAggregator(config)
    for (const item of healthySignals()) aggregator.report(item)

    const stale = aggregator.evaluate(readings({ nowMonotonicMs: config.signalStaleAfterMs + 1 }))

    // Stale is not degraded — it is "not observed" — but a required family that
    // stays unobservable past the grace *is* degraded.
    expect(stale.families.obs_output.status).toBe('unknown')
    const later = aggregator.evaluate(
      readings({ nowMonotonicMs: config.signalStaleAfterMs + config.unobservableGraceMs + 1 }),
    )
    expect(later.families.obs_output.status).toBe('degraded')
    expect(later.families.obs_output.unobservableEscalated).toBe(true)
  })

  it('leaves a non-required family unknown however long it stays unobservable', () => {
    const aggregator = new HealthAggregator(config)
    // `chat_transport` is not required: a chat nobody has connected yet is not a
    // broadcast fault (spec §9.4(3), §2.1).
    const result = aggregator.evaluate(readings({ nowMonotonicMs: 10 * 60_000 }))

    expect(result.families.chat_transport.status).toBe('unknown')
    expect(config.requiredFamilies).not.toContain('chat_transport')
  })

  it('never lets a silent chat make the input path unhealthy', () => {
    const aggregator = new HealthAggregator(config)
    for (const item of healthySignals()) aggregator.report(item)
    aggregator.report(
      signal('youtube.chat.user_events', 'ok', { component: 'youtube-chat', reason: undefined }),
    )

    expect(aggregator.evaluate(readings()).inputHealthy).toBe(true)
  })

  it('turns the CTA off when the transport or the moderation control is unhealthy', () => {
    const aggregator = new HealthAggregator(config)
    for (const item of healthySignals()) aggregator.report(item)
    aggregator.report(
      signal('youtube.chat.transport', 'degraded', {
        component: 'youtube-chat',
        reason: 'retry_budget_exhausted',
      }),
    )

    expect(aggregator.evaluate(readings()).inputHealthy).toBe(false)
    // §12.3: an unhealthy moderation control does the same, on its own.
    const moderation = new HealthAggregator(config)
    for (const item of healthySignals()) moderation.report(item)
    expect(
      moderation.evaluate(
        readings({ moderation: { status: 'degraded', reason: 'filter_unavailable' } }),
      ).inputHealthy,
    ).toBe(false)
  })

  describe('families the supervisor derives itself', () => {
    it('reports the coordinator as degraded while the writer is failing (§9.4(1))', () => {
      const aggregator = new HealthAggregator(config)
      const result = aggregator.evaluate(
        readings({
          engine: {
            ...BASE_ENGINE_HEALTH,
            consecutiveFailures: 2,
            lastFailure: { at: '2026-01-01T00:00:00.000Z', error: 'disk full' },
          },
        }),
      )

      expect(result.families.coordinator.status).toBe('degraded')
      expect(result.families.coordinator.reason).toBe('writer_failing')
    })

    it('reports a stalled evaluation loop as a coordinator fault', () => {
      const aggregator = new HealthAggregator(config)
      const result = aggregator.evaluate(
        readings({
          lastEvaluationMonotonicMs: 0,
          nowMonotonicMs: config.coordinatorHeartbeatTimeoutMs + 1,
        }),
      )

      expect(result.families.coordinator.reason).toBe('evaluation_stalled')
    })

    it('measures the age of the last committed transition (§9.4(2))', () => {
      const aggregator = new HealthAggregator(config)
      const fresh = aggregator.evaluate(readings())
      expect(fresh.families.state_commit.status).toBe('ok')

      const stale = aggregator.evaluate(
        readings({
          nowUtc: new Date(
            Date.parse('2026-01-01T00:00:00.000Z') + config.stateCommitStaleAfterMs + 1,
          ).toISOString(),
        }),
      )
      expect(stale.families.state_commit.status).toBe('degraded')
      expect(stale.families.state_commit.reason).toBe('state_commit_stale')
    })

    it('reports a world that has not committed yet as unknown, not broken', () => {
      const aggregator = new HealthAggregator(config)
      const result = aggregator.evaluate(
        readings({ engine: { ...BASE_ENGINE_HEALTH, lastCommittedAt: null } }),
      )

      expect(result.families.state_commit.status).toBe('unknown')
      expect(result.families.state_commit.reason).toBe('no_commit_yet')
    })

    it('reports the renderer from its frame, its context and the engine ACK (§9.4(4))', () => {
      const aggregator = new HealthAggregator(config)
      expect(aggregator.evaluate(readings()).families.renderer.status).toBe('ok')

      expect(
        aggregator.evaluate(readings({ renderer: { ...HEALTHY_RENDERER, webglContextLost: true } }))
          .families.renderer.reason,
      ).toBe('webgl_context_lost')

      expect(
        aggregator.evaluate(readings({ renderer: { ...HEALTHY_RENDERER, fps: 3 } })).families
          .renderer.reason,
      ).toBe('fps_below_minimum')

      expect(
        aggregator.evaluate(
          readings({
            engine: {
              ...BASE_ENGINE_HEALTH,
              degraded: true,
              degradedReasons: ['renderer_ack_stale'],
            },
          }),
        ).families.renderer.reason,
      ).toBe('renderer_ack_stale')
    })

    it('reports a renderer heartbeat that stopped arriving', () => {
      const aggregator = new HealthAggregator(config)
      const result = aggregator.evaluate(
        readings({
          nowUtc: new Date(
            Date.parse('2026-01-01T00:00:00.000Z') + config.renderer.reportStaleAfterMs + 1,
          ).toISOString(),
        }),
      )

      expect(result.families.renderer.reason).toBe('renderer_heartbeat_stale')
    })

    it('reports the dead-man push without letting it stop a healthy broadcast (§9.4(8))', () => {
      const aggregator = new HealthAggregator(config)
      const failed = aggregator.evaluate(
        readings({
          deadMan: {
            enabled: true,
            lastPushAt: '2026-01-01T00:00:00.000Z',
            lastPushOk: false,
            consecutiveFailures: 3,
            lastError: 'ECONNREFUSED',
          },
        }),
      )

      expect(failed.families.dead_man.status).toBe('degraded')
      // It is not one of the required families, so the escalation that would
      // stop the run for an unobservable encoder does not apply here.
      expect(config.requiredFamilies).not.toContain('dead_man')
    })
  })

  it('takes its timestamps from the injected clock', () => {
    const clock = new FakeClock()
    const aggregator = new HealthAggregator(config)
    const result = aggregator.evaluate(
      readings({ nowUtc: clock.nowUtcIso(), nowMonotonicMs: clock.monotonicMs() }),
    )

    expect(result.atUtc).toBe('2026-01-01T00:00:00.000Z')
  })
})
