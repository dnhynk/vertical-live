import { describe, expect, it } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import { InputArbiter } from './arbiter.js'
import { CommandMetrics } from './metrics.js'
import { parseMessage, type ParserLimits } from './parse.js'
import type { ParseContext } from './types.js'

const LIMITS: ParserLimits = { maxRawLength: 500 }
const GATE_CLOSED: ParseContext = { identityGateOpen: false, voteWindowOpen: false }

describe('command success metric (spec §14.1)', () => {
  it('is null before any command-like message', () => {
    expect(new CommandMetrics().snapshot().commandSuccessRatio).toBeNull()
  })

  it('divides accepted commands by messages that looked like commands', () => {
    const metrics = new CommandMetrics()
    for (const text of ['feed', 'ごはん', 'feed https://example.invalid', 'a']) {
      metrics.recordParse(parseMessage(text, GATE_CLOSED, LIMITS))
    }
    const snapshot = metrics.snapshot()
    // 4 command-like messages, 2 accepted: a link and a blocked vote are not.
    expect(snapshot.commandLike).toBe(4)
    expect(snapshot.accepted).toBe(2)
    expect(snapshot.commandSuccessRatio).toBe(0.5)
  })

  it('does not count a message that never looked like a command', () => {
    const metrics = new CommandMetrics()
    metrics.recordParse(parseMessage('こんばんは', GATE_CLOSED, LIMITS))
    const snapshot = metrics.snapshot()
    expect(snapshot.commandLike).toBe(0)
    expect(snapshot.rejectedByReason.no_command).toBe(1)
    expect(snapshot.commandSuccessRatio).toBeNull()
  })

  it('counts each rejection under its own code and nothing else', () => {
    const metrics = new CommandMetrics()
    metrics.recordParse(parseMessage('feed https://example.invalid', GATE_CLOSED, LIMITS))
    metrics.recordParse(parseMessage('feed p0rn', GATE_CLOSED, LIMITS))
    metrics.recordParse(parseMessage('a', GATE_CLOSED, LIMITS))
    const { rejectedByReason, rejected } = metrics.snapshot()
    expect(rejected).toBe(3)
    expect(rejectedByReason.url).toBe(1)
    expect(rejectedByReason.banned_sexual).toBe(1)
    expect(rejectedByReason.vote_disabled).toBe(1)
    expect(rejectedByReason.no_command).toBe(0)
  })
})

describe('arbiter counters', () => {
  it('separates directly applied commands from aggregated ones', async () => {
    const clock = new FakeClock()
    const arbiter = new InputArbiter({
      clock,
      config: {
        windowMs: 1000,
        enterAggregateAtCommands: 100,
        exitAggregateAtCommands: 1,
        maxDirectPerWindow: 2,
      },
    })
    const metrics = new CommandMetrics()
    for (let index = 0; index < 5; index += 1) {
      metrics.recordAdmission(arbiter.admit({ name: 'FEED', argument: null }))
    }
    await clock.advance(1000)
    for (const window of arbiter.drainClosedWindows()) {
      metrics.recordWindow(window)
    }
    const snapshot = metrics.snapshot()
    expect(snapshot.directApplied).toBe(2)
    expect(snapshot.aggregated).toBe(3)
    expect(snapshot.windowsClosed).toBe(1)
    // Every command is still represented once the window closes.
    expect(snapshot.windowContributions).toBe(5)
  })
})

describe('reset', () => {
  it('clears every counter', () => {
    const metrics = new CommandMetrics()
    metrics.recordParse(parseMessage('feed', GATE_CLOSED, LIMITS))
    metrics.reset()
    expect(metrics.snapshot()).toEqual({
      commandLike: 0,
      accepted: 0,
      rejected: 0,
      rejectedByReason: {
        too_long: 0,
        empty: 0,
        url: 0,
        personal_data: 0,
        banned_hate: 0,
        banned_sexual: 0,
        banned_self_harm: 0,
        banned_violence: 0,
        banned_ads_scam: 0,
        no_command: 0,
        extraneous_text: 0,
        invalid_argument: 0,
        vote_disabled: 0,
      },
      directApplied: 0,
      aggregated: 0,
      windowsClosed: 0,
      windowContributions: 0,
      commandSuccessRatio: null,
    })
  })
})
