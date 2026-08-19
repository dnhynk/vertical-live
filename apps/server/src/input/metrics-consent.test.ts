import { describe, expect, it } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import { InputArbiter } from './arbiter.js'
import { CommandMetrics } from './metrics.js'
import { parseMessage, type ParserLimits } from './parse.js'
import type { ParseContext } from './types.js'

/**
 * The consent half of the §14.1 metric (BOARD D-9), kept in its own file so the
 * closed configuration's expectations in `metrics.test.ts` stay exactly as they
 * were before T20b — which is what §T20b acceptance 1d asks for, and what review
 * round 1 (M1) found had been edited instead.
 */

const LIMITS: ParserLimits = { maxRawLength: 500 }
const GATE_CLOSED: ParseContext = { identityGateOpen: false, voteWindowOpen: false }
const GATE_OPEN: ParseContext = { identityGateOpen: true, voteWindowOpen: false }
const ACTOR = {
  kind: 'consented',
  displayName: 'synthetic-viewer',
  channelRef: 'ref_test01',
} as const

function openMetrics(): CommandMetrics {
  return new CommandMetrics({ consentGateOpen: true })
}

describe('closed gate (BOARD A-1)', () => {
  it('publishes the pre-D-9 document, with no consent field anywhere', () => {
    const metrics = new CommandMetrics()
    metrics.recordParse(parseMessage('なのる', GATE_CLOSED, LIMITS))
    const snapshot = metrics.snapshot()

    // The refusal is counted — it happened — but it brings no new key with it.
    expect(snapshot.rejected).toBe(1)
    expect(Object.keys(snapshot)).not.toContain('consentAccepted')
    expect(Object.keys(snapshot)).not.toContain('suppressed')
    expect(Object.keys(snapshot.rejectedByReason)).not.toContain('consent_disabled')
    // Byte-for-byte: the serialized document has none of the three tokens.
    const json = JSON.stringify(snapshot)
    expect(json).not.toContain('consentAccepted')
    expect(json).not.toContain('suppressed')
    expect(json).not.toContain('consent_disabled')
  })

  it('keeps the success ratio the pre-D-9 formula', () => {
    const metrics = new CommandMetrics()
    for (const text of ['feed', 'なのる']) {
      metrics.recordParse(parseMessage(text, GATE_CLOSED, LIMITS))
    }
    // 2 command-like, 1 accepted world command, and no consent term to add.
    expect(metrics.snapshot().commandSuccessRatio).toBe(0.5)
  })
})

describe('open gate (BOARD D-9)', () => {
  it('counts an accepted consent command separately from a world command', () => {
    const metrics = openMetrics()
    metrics.recordParse(parseMessage('feed', GATE_OPEN, LIMITS))
    metrics.recordParse(parseMessage('なのる', GATE_OPEN, LIMITS))
    metrics.recordParse(parseMessage('なまえけす', GATE_OPEN, LIMITS))

    const snapshot = metrics.snapshot()
    expect(snapshot.accepted).toBe(1)
    expect(snapshot.consentAccepted).toBe(2)
    // §14.1 "수락된 명령 / 명령처럼 보이는 메시지": all three were successes.
    expect(snapshot.commandSuccessRatio).toBe(1)
  })

  it('counts a suppressed command and never as an applied one', () => {
    const clock = new FakeClock()
    const arbiter = new InputArbiter({
      clock,
      config: {
        windowMs: 5000,
        enterAggregateAtCommands: 100,
        exitAggregateAtCommands: 10,
        maxDirectPerWindow: 20,
      },
      perUser: { cooldownMs: 5000 },
    })
    const metrics = openMetrics()

    metrics.recordAdmission(arbiter.admit({ name: 'FEED', argument: null }, ACTOR))
    clock.advance(10)
    metrics.recordAdmission(arbiter.admit({ name: 'FEED', argument: null }, ACTOR))

    const snapshot = metrics.snapshot()
    expect(snapshot.directApplied).toBe(1)
    expect(snapshot.suppressed).toBe(1)
    expect(snapshot.aggregated).toBe(0)
  })

  it('gives the consent refusal its own code once the gate is open', () => {
    // `vote_disabled` is the shape of an existing per-code count; the consent
    // code joins it only here, where the feature it names exists.
    const metrics = openMetrics()
    metrics.recordParse(parseMessage('a b c d e f', GATE_OPEN, LIMITS))
    expect(Object.keys(metrics.snapshot().rejectedByReason)).toContain('consent_disabled')
    expect(metrics.snapshot().rejectedByReason.consent_disabled).toBe(0)
  })
})
