import { describe, expect, it, vi } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import { runStartupSequence, STARTUP_STEP_ORDER, type StartupSteps } from './startup.js'

/**
 * The start-up order of spec §7.3(3) and §9.1, fixed in code and in this test
 * (TASK_SPECS §T12 배선). The runner iterates `STARTUP_STEP_ORDER`, so a caller
 * supplies a step per name and cannot reorder them by rearranging its object.
 */

function recordingSteps(order: string[], failAt?: string): StartupSteps {
  const step = (name: string) => () => {
    order.push(name)
    if (name === failAt) throw new Error(`${name} failed`)
  }
  return {
    db: step('db'),
    engine: step('engine'),
    retention: step('retention'),
    broadcast: step('broadcast'),
    streamService: step('streamService'),
    startStream: step('startStream'),
    goLive: step('goLive'),
    chatSource: step('chatSource'),
    publish: step('publish'),
  }
}

describe('start-up sequence', () => {
  it('runs the steps in the order the spec fixes', async () => {
    const order: string[] = []
    const result = await runStartupSequence({
      steps: recordingSteps(order),
      clock: new FakeClock(),
    })

    expect(order).toEqual([
      'db',
      'engine',
      'retention',
      'broadcast',
      'streamService',
      'startStream',
      'goLive',
      'chatSource',
      'publish',
    ])
    expect(order).toEqual([...STARTUP_STEP_ORDER])
    expect(result.completed).toBe(true)
  })

  it('ignores the order of the object it is given', async () => {
    const order: string[] = []
    const declared = recordingSteps(order)
    // Same steps, declared back to front.
    const reversed = Object.fromEntries(
      [...Object.entries(declared)].reverse(),
    ) as unknown as StartupSteps

    await runStartupSequence({ steps: reversed, clock: new FakeClock() })

    expect(order).toEqual([...STARTUP_STEP_ORDER])
  })

  it('stops at the first failure and skips everything that depends on it', async () => {
    const order: string[] = []
    const result = await runStartupSequence({
      steps: recordingSteps(order, 'broadcast'),
      clock: new FakeClock(),
    })

    expect(order).toEqual(['db', 'engine', 'retention', 'broadcast'])
    expect(result.completed).toBe(false)
    expect(result.failedStep).toBe('broadcast')
    expect(result.error).toBe('broadcast failed')
    expect(
      result.steps.filter((step) => step.status === 'skipped').map((step) => step.step),
    ).toEqual(['streamService', 'startStream', 'goLive', 'chatSource', 'publish'])
  })

  it('reports every step so an operator sees what did and did not run', async () => {
    const onStep = vi.fn()
    const result = await runStartupSequence({
      steps: recordingSteps([]),
      clock: new FakeClock(),
      onStep,
    })

    expect(onStep).toHaveBeenCalledTimes(STARTUP_STEP_ORDER.length)
    expect(result.steps.every((step) => step.status === 'completed')).toBe(true)
    expect(result.steps.every((step) => step.at === '2026-01-01T00:00:00.000Z')).toBe(true)
  })

  it('awaits an asynchronous step before starting the next one', async () => {
    const order: string[] = []
    const steps = recordingSteps(order)
    const withAsyncBroadcast: StartupSteps = {
      ...steps,
      broadcast: async () => {
        await Promise.resolve()
        order.push('broadcast-finished')
      },
    }

    await runStartupSequence({ steps: withAsyncBroadcast, clock: new FakeClock() })

    expect(order.indexOf('broadcast-finished')).toBeLessThan(order.indexOf('streamService'))
  })
})
