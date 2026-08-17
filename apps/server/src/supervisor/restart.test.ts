import { describe, expect, it, vi } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import { createExponentialBackoff } from '../youtube/quota/backoff.js'
import {
  DelegatedRestartError,
  DuplicateSupervisorError,
  MissingSupervisorError,
  RestartSupervisor,
  SupervisorRegistry,
  type RestartExhaustedEvent,
} from './restart.js'
import { SUPERVISED_COMPONENTS } from './types.js'

/**
 * One restart supervisor per component (spec §10.2), backoff between attempts,
 * and `safe_stopped` when the budget is gone (spec §9.2).
 */

function backoff(maxAttempts: number) {
  return createExponentialBackoff({
    initialDelayMs: 1000,
    maxDelayMs: 8000,
    factor: 2,
    jitterRatio: 0,
    maxAttempts,
    random: () => 0,
  })
}

describe('RestartSupervisor', () => {
  it('waits the backoff delay before each attempt', async () => {
    const clock = new FakeClock()
    const attempts: number[] = []
    const supervisor = new RestartSupervisor({
      component: 'engine',
      clock,
      backoff: backoff(3),
      restart: () => {
        attempts.push(clock.monotonicMs())
        return Promise.resolve()
      },
    })

    expect(supervisor.request('writer_failing')).toBe('scheduled')
    expect(attempts).toEqual([])
    expect(supervisor.inFlight).toBe(true)

    await clock.advance(1000)
    expect(attempts).toEqual([1000])
    expect(supervisor.inFlight).toBe(false)

    supervisor.request('writer_failing')
    await clock.advance(2000)
    expect(attempts).toEqual([1000, 3000])
  })

  it('ignores a second request while one is in flight', async () => {
    const clock = new FakeClock()
    const restart = vi.fn(() => Promise.resolve())
    const supervisor = new RestartSupervisor({
      component: 'engine',
      clock,
      backoff: backoff(3),
      restart,
    })

    supervisor.request('a')
    expect(supervisor.request('b')).toBe('in_flight')
    await clock.advance(1000)

    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('records a failed restart without throwing', async () => {
    const clock = new FakeClock()
    const supervisor = new RestartSupervisor({
      component: 'chat-source',
      clock,
      backoff: backoff(3),
      restart: () => Promise.reject(new Error('socket refused')),
    })

    supervisor.request('transport')
    await clock.advance(1000)

    expect(supervisor.health().lastError).toBe('socket refused')
    expect(supervisor.exhausted).toBe(false)
  })

  it('reports exhaustion after the last attempt fails (spec §9.2)', async () => {
    const clock = new FakeClock()
    const exhausted: RestartExhaustedEvent[] = []
    const supervisor = new RestartSupervisor({
      component: 'chat-source',
      clock,
      backoff: backoff(2),
      restart: () => Promise.reject(new Error('still refused')),
      onExhausted: (event) => exhausted.push(event),
    })

    supervisor.request('transport')
    await clock.advance(1000)
    supervisor.request('transport')
    await clock.advance(2000)

    expect(supervisor.exhausted).toBe(true)
    expect(exhausted).toHaveLength(1)
    expect(exhausted[0]?.attempts).toBe(2)
    expect(exhausted[0]?.escalatesTo).toBeNull()
    expect(supervisor.request('transport')).toBe('exhausted')
  })

  it('returns the budget once the component is healthy again', async () => {
    const clock = new FakeClock()
    const supervisor = new RestartSupervisor({
      component: 'engine',
      clock,
      backoff: backoff(2),
      restart: () => Promise.resolve(),
    })

    supervisor.request('writer_failing')
    await clock.advance(1000)
    expect(supervisor.attempts).toBe(1)

    supervisor.noteHealthy()
    expect(supervisor.attempts).toBe(0)
  })

  describe('delegated components (spec §10.2)', () => {
    it('refuses to restart a component whose loop is owned elsewhere', () => {
      const supervisor = new RestartSupervisor({
        component: 'obs-connection',
        owner: 'obs.ObsClient',
        clock: new FakeClock(),
        backoff: backoff(3),
      })

      expect(supervisor.delegated).toBe(true)
      expect(() => supervisor.request('unreachable')).toThrow(DelegatedRestartError)
    })

    it('escalates to the declared target when the owner has retried past its budget', () => {
      const exhausted: RestartExhaustedEvent[] = []
      const supervisor = new RestartSupervisor({
        component: 'obs-connection',
        owner: 'obs.ObsClient',
        escalatesTo: 'obs-process',
        clock: new FakeClock(),
        backoff: backoff(3),
        onExhausted: (event) => exhausted.push(event),
      })

      expect(supervisor.observeExternalAttempts(2, 'unreachable')).toBe('in_flight')
      expect(supervisor.observeExternalAttempts(3, 'unreachable')).toBe('exhausted')
      expect(exhausted[0]?.escalatesTo).toBe('obs-process')
    })

    it('refuses to be driven as if it owned a loop', () => {
      const supervisor = new RestartSupervisor({
        component: 'engine',
        clock: new FakeClock(),
        backoff: backoff(2),
        restart: () => Promise.resolve(),
      })

      expect(() => supervisor.observeExternalAttempts(1, 'x')).toThrow(
        /observeExternalAttempts is for delegated entries only/,
      )
    })
  })

  describe('stopping (review round 1, B1)', () => {
    it('cancels an attempt that was already waiting out its backoff', async () => {
      const clock = new FakeClock()
      const restart = vi.fn(() => Promise.resolve())
      const supervisor = new RestartSupervisor({
        component: 'obs-stream',
        clock,
        backoff: backoff(3),
        restart,
      })

      supervisor.request('output_inactive')
      supervisor.stop()
      await clock.advance(60_000)

      expect(restart).not.toHaveBeenCalled()
      expect(supervisor.stopped).toBe(true)
      expect(supervisor.inFlight).toBe(false)
    })

    it('refuses every later request', () => {
      const supervisor = new RestartSupervisor({
        component: 'engine',
        clock: new FakeClock(),
        backoff: backoff(3),
        restart: () => Promise.resolve(),
      })

      supervisor.stop()

      expect(supervisor.request('writer_failing')).toBe('stopped')
    })

    it('asks again in the moment before it acts', async () => {
      // The timer callback can already be running when the run stops, so the
      // action is gated a second time rather than only by the cancellation.
      const clock = new FakeClock()
      const restart = vi.fn(() => Promise.resolve())
      let allowed = true
      const supervisor = new RestartSupervisor({
        component: 'obs-stream',
        clock,
        backoff: backoff(3),
        restart,
        canRestart: () => allowed,
      })

      supervisor.request('output_inactive')
      allowed = false
      await clock.advance(1000)

      expect(restart).not.toHaveBeenCalled()
      expect(supervisor.inFlight).toBe(false)
    })

    it('does not hand the budget back to a stopped component', () => {
      const supervisor = new RestartSupervisor({
        component: 'engine',
        clock: new FakeClock(),
        backoff: backoff(3),
        restart: () => Promise.resolve(),
      })

      supervisor.request('writer_failing')
      supervisor.stop()
      supervisor.noteHealthy()

      expect(supervisor.attempts).toBe(1)
    })
  })

  it('refuses to build a supervisor-owned entry with nothing to restart', () => {
    expect(
      () =>
        new RestartSupervisor({
          component: 'engine',
          clock: new FakeClock(),
          backoff: backoff(2),
        }),
    ).toThrow(/needs a restart action/)
  })
})

describe('SupervisorRegistry', () => {
  const entry = (component: (typeof SUPERVISED_COMPONENTS)[number]) =>
    new RestartSupervisor({
      component,
      clock: new FakeClock(),
      backoff: backoff(2),
      restart: () => Promise.resolve(),
    })

  it('refuses a second supervisor for the same component (spec §10.2)', () => {
    const registry = new SupervisorRegistry()
    registry.register(entry('engine'))

    expect(() => registry.register(entry('engine'))).toThrow(DuplicateSupervisorError)
  })

  it('refuses to report itself complete while a component is uncovered', () => {
    const registry = new SupervisorRegistry()
    registry.register(entry('engine'))

    expect(() => registry.assertComplete()).toThrow(MissingSupervisorError)
  })

  it('is complete once every component has exactly one', () => {
    const registry = new SupervisorRegistry()
    for (const component of SUPERVISED_COMPONENTS) registry.register(entry(component))

    expect(() => registry.assertComplete()).not.toThrow()
    expect(registry.all()).toHaveLength(SUPERVISED_COMPONENTS.length)
  })

  it('stops every component at once (spec §9.1, §9.2)', () => {
    const registry = new SupervisorRegistry()
    for (const component of SUPERVISED_COMPONENTS) registry.register(entry(component))

    registry.stopAll()

    expect(registry.all().every((supervisor) => supervisor.stopped)).toBe(true)
  })
})
