import { describe, expect, it } from 'vitest'

import { loadInputConfig, parserLimits } from '../input/config.js'
import { REJECTED_VECTORS } from '../input/fixtures/adversarial.js'
import { CommandMetrics } from '../input/metrics.js'
import { moderate } from '../input/moderation.js'
import { normalizeText } from '../input/normalize.js'
import { parseMessage } from '../input/parse.js'
import { REJECTION_REASONS, type RejectionReason } from '../input/types.js'
import { FakeClock } from '../testing/fake-clock.js'
import { loadSupervisorConfig } from './config.js'
import {
  FILTER_EVASION_REJECTION_REASONS,
  FilterEvasionDetector,
  type FilterEvasionHeuristicConfig,
} from './moderation-heuristic.js'

/**
 * The automatic half of spec §12.3 (TASK_SPECS §T22 acceptance 2).
 *
 * Windows are driven with real messages through the real parser rather than a
 * hand-written snapshot: what this detector claims to measure is what the T6
 * rejection codes mean, so a test that invents the codes would prove nothing
 * about that claim.
 */

const LIMITS = parserLimits(loadInputConfig({ env: {} }))

const CONFIG: FilterEvasionHeuristicConfig = {
  enabled: true,
  windowMs: 60_000,
  minMessages: 20,
  rejectRatio: 0.5,
  enterWindows: 3,
  clearWindows: 3,
}

/** Shape and gate codes: everyday chat and everyday mistakes, never a surge. */
const SHAPE_REJECTION_REASONS: readonly RejectionReason[] = [
  'too_long',
  'empty',
  'no_command',
  'extraneous_text',
  'invalid_argument',
  'vote_disabled',
  'consent_disabled',
]

/** Synthetic evasion vectors, one per code `moderate()` can produce. */
const EVASION_MESSAGES: readonly string[] = [
  'feed example(dot)invalid',
  'feed someone (at) example.invalid',
  'ｷﾁｶﾞｲ',
  'feed p0rn',
  'k y s',
  'feed 殺す',
  'feed 儲かる 副業',
]

/** Ordinary chat: a command, a cheer, a mistake. Nothing to call a human for. */
const BENIGN_MESSAGES: readonly string[] = ['feed', 'play', 'かわいい', 'feed play', 'pet']

function harness(
  overrides: Partial<FilterEvasionHeuristicConfig> = {},
  options: { readonly consentGateOpen?: boolean } = {},
): {
  readonly clock: FakeClock
  readonly detector: FilterEvasionDetector
  readonly metrics: CommandMetrics
  send(messages: readonly string[], times?: number): void
  closeWindow(): ReturnType<FilterEvasionDetector['observe']>
} {
  const clock = new FakeClock()
  const consentGateOpen = options.consentGateOpen === true
  const metrics = new CommandMetrics({ consentGateOpen })
  const config = { ...CONFIG, ...overrides }
  const detector = new FilterEvasionDetector({
    config,
    clock,
    metrics: () => metrics.snapshot(),
  })
  // The first observation only opens the first window.
  detector.observe()

  return {
    clock,
    detector,
    metrics,
    send(messages, times = 1) {
      for (let round = 0; round < times; round += 1) {
        for (const text of messages) {
          metrics.recordParse(
            parseMessage(
              text,
              { identityGateOpen: consentGateOpen, voteWindowOpen: false },
              LIMITS,
            ),
          )
        }
      }
    },
    closeWindow() {
      void clock.advance(config.windowMs)
      return detector.observe()
    },
  }
}

describe('which rejection codes count as filter evasion', () => {
  it('is exactly the set `moderate()` produces (coordinator ask, 2026-08-20)', () => {
    // Every evasion code has to be reachable through the moderation rules, which
    // run *after* obfuscation is undone (`input/moderation.ts`). That is what
    // makes the count an observation of "변형 입력", not of bad typing.
    const produced = new Set<RejectionReason>()
    for (const vector of REJECTED_VECTORS) {
      const reason = moderate(normalizeText(vector.text))
      if (reason !== null) produced.add(reason)
    }

    expect([...produced].sort()).toEqual([...FILTER_EVASION_REJECTION_REASONS].sort())
  })

  it('partitions every T6 rejection code exactly once', () => {
    // A code that is in neither list is a code nobody classified; a code in both
    // would be counted twice. Either is a silent hole in the §12.3 signal.
    const all = [...FILTER_EVASION_REJECTION_REASONS, ...SHAPE_REJECTION_REASONS]

    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual([...REJECTION_REASONS].sort())
  })

  it('never classifies an ordinary chat line as evasion', () => {
    for (const text of BENIGN_MESSAGES) {
      const result = parseMessage(text, { identityGateOpen: false, voteWindowOpen: false }, LIMITS)
      if (result.status !== 'rejected') continue
      expect(FILTER_EVASION_REJECTION_REASONS).not.toContain(result.reason)
    }
  })
})

describe('window accounting', () => {
  it('closes a window only after windowMs has passed on the monotonic clock', () => {
    const h = harness()
    h.send(EVASION_MESSAGES, 5)

    void h.clock.advance(CONFIG.windowMs - 1)
    expect(h.detector.observe()).toBeNull()
    expect(h.detector.state().windowsClosed).toBe(0)

    void h.clock.advance(1)
    expect(h.detector.observe()).toBeNull()
    expect(h.detector.state().windowsClosed).toBe(1)
  })

  it('computes the ratio over messages that reached the parser', () => {
    const h = harness()
    // 35 evasion rejections and 25 ordinary messages: 35/60 ≈ 0.58.
    h.send(EVASION_MESSAGES, 5)
    h.send(BENIGN_MESSAGES, 5)
    h.closeWindow()

    const window = h.detector.state().lastWindow
    expect(window?.messages).toBe(60)
    expect(window?.evasionRejections).toBe(35)
    expect(window?.ratio).toBeCloseTo(35 / 60, 5)
    expect(window?.exceeded).toBe(true)
  })

  it('counts only differences, so a window is not the run so far', () => {
    const h = harness()
    h.send(EVASION_MESSAGES, 5)
    h.closeWindow()
    h.send(BENIGN_MESSAGES, 5)
    h.closeWindow()

    expect(h.detector.state().lastWindow?.evasionRejections).toBe(0)
    expect(h.detector.state().lastWindow?.messages).toBe(25)
  })
})

describe('entering and leaving the reported state', () => {
  it('reports only after enterWindows consecutive exceeding windows', () => {
    const h = harness()

    for (let window = 0; window < CONFIG.enterWindows - 1; window += 1) {
      h.send(EVASION_MESSAGES, 5)
      expect(h.closeWindow()).toBeNull()
      expect(h.detector.state().reported).toBe(false)
    }

    h.send(EVASION_MESSAGES, 5)
    expect(h.closeWindow()).toBe('report')
    expect(h.detector.state().reported).toBe(true)
    expect(h.detector.state().consecutiveExceeding).toBe(CONFIG.enterWindows)
  })

  it('does not report again while the condition stands', () => {
    const h = harness()
    for (let window = 0; window < CONFIG.enterWindows; window += 1) {
      h.send(EVASION_MESSAGES, 5)
      h.closeWindow()
    }

    h.send(EVASION_MESSAGES, 5)
    expect(h.closeWindow()).toBeNull()
    expect(h.detector.state().reported).toBe(true)
  })

  it('one quiet window in the middle restarts the count', () => {
    const h = harness()
    h.send(EVASION_MESSAGES, 5)
    h.closeWindow()
    h.send(EVASION_MESSAGES, 5)
    h.closeWindow()

    h.send(BENIGN_MESSAGES, 5)
    h.closeWindow()
    expect(h.detector.state().consecutiveExceeding).toBe(0)

    h.send(EVASION_MESSAGES, 5)
    h.closeWindow()
    h.send(EVASION_MESSAGES, 5)
    expect(h.closeWindow()).toBeNull()
    expect(h.detector.state().reported).toBe(false)
  })

  it('clears after clearWindows consecutive quiet windows', () => {
    const h = harness()
    for (let window = 0; window < CONFIG.enterWindows; window += 1) {
      h.send(EVASION_MESSAGES, 5)
      h.closeWindow()
    }
    expect(h.detector.state().reported).toBe(true)

    for (let window = 0; window < CONFIG.clearWindows - 1; window += 1) {
      h.send(BENIGN_MESSAGES, 5)
      expect(h.closeWindow()).toBeNull()
      expect(h.detector.state().reported).toBe(true)
    }

    h.send(BENIGN_MESSAGES, 5)
    expect(h.closeWindow()).toBe('clear')
    expect(h.detector.state().reported).toBe(false)
  })
})

describe('no false positives', () => {
  it('stays silent on ordinary chat however long it runs', () => {
    const h = harness()

    for (let window = 0; window < 20; window += 1) {
      h.send(BENIGN_MESSAGES, 10)
      expect(h.closeWindow()).toBeNull()
    }

    expect(h.detector.state().reported).toBe(false)
    expect(h.detector.state().lastWindow?.exceeded).toBe(false)
  })

  it('stays silent below the ratio, even with evasion attempts in every window', () => {
    const h = harness()

    for (let window = 0; window < 10; window += 1) {
      // 7 evasion attempts against 50 ordinary messages: 0.12, well under 0.5.
      h.send(EVASION_MESSAGES)
      h.send(BENIGN_MESSAGES, 10)
      expect(h.closeWindow()).toBeNull()
    }

    expect(h.detector.state().reported).toBe(false)
  })

  it('ignores a window too small to mean anything (minMessages)', () => {
    const h = harness()

    for (let window = 0; window < 10; window += 1) {
      // Every message in the window is an evasion attempt — ratio 1.0 — but
      // seven of them is a couple of trolls, not "자동 차단이 무력해졌다".
      h.send(EVASION_MESSAGES)
      expect(h.closeWindow()).toBeNull()
      expect(h.detector.state().lastWindow?.ratio).toBe(1)
      expect(h.detector.state().lastWindow?.exceeded).toBe(false)
    }

    expect(h.detector.state().reported).toBe(false)
  })

  it('treats an empty window as quiet rather than as a division by zero', () => {
    const h = harness()

    expect(h.closeWindow()).toBeNull()
    expect(h.detector.state().lastWindow?.ratio).toBeNull()
    expect(h.detector.state().lastWindow?.exceeded).toBe(false)
  })

  it('re-bases instead of going negative when the collector is reset', () => {
    const h = harness()
    h.send(EVASION_MESSAGES, 5)
    h.closeWindow()

    h.metrics.reset()
    h.send(BENIGN_MESSAGES, 5)
    h.closeWindow()

    expect(h.detector.state().lastWindow?.evasionRejections).toBe(0)
    expect(h.detector.state().lastWindow?.messages).toBe(0)
  })

  it('does nothing at all while it is disabled', () => {
    const h = harness({ enabled: false })
    h.send(EVASION_MESSAGES, 20)

    for (let window = 0; window < 5; window += 1) expect(h.closeWindow()).toBeNull()
    expect(h.detector.state()).toMatchObject({ enabled: false, windowsClosed: 0 })
  })
})

describe('identity mode', () => {
  it('reaches the same verdict with the consent gate open and closed', () => {
    for (const consentGateOpen of [false, true]) {
      const h = harness({}, { consentGateOpen })
      // `JOIN` is an accepted consent command open and a `consent_disabled`
      // rejection closed, and the per-code counts lose that key while it is
      // closed (`input/metrics.ts`). Neither may move this detector.
      let verdict: ReturnType<FilterEvasionDetector['observe']> = null
      for (let window = 0; window < CONFIG.enterWindows; window += 1) {
        h.send(EVASION_MESSAGES, 5)
        h.send(['なのる', 'なのる'])
        verdict = h.closeWindow()
      }

      expect(verdict).toBe('report')
      expect(h.detector.state().lastWindow?.messages).toBe(37)
      expect(h.detector.state().lastWindow?.evasionRejections).toBe(35)
    }
  })
})

describe('repository configuration', () => {
  it('carries the heuristic thresholds as provisional values (BOARD A-15/D-14)', () => {
    const config = loadSupervisorConfig()
    const filterEvasion = config.moderation.heuristics.filterEvasion

    expect(filterEvasion.enabled).toBe(true)
    expect(filterEvasion.windowMs).toBeGreaterThan(0)
    expect(filterEvasion.minMessages).toBeGreaterThan(0)
    expect(filterEvasion.rejectRatio).toBeGreaterThan(0)
    expect(filterEvasion.rejectRatio).toBeLessThanOrEqual(1)
    expect(filterEvasion.enterWindows).toBeGreaterThan(0)
    expect(filterEvasion.clearWindows).toBeGreaterThan(0)
    // Nothing here is a pass line: §T22 acceptance 3 requires every threshold to
    // be listed as provisional until the Gate 2 baseline locks it.
    for (const key of ['windowMs', 'minMessages', 'rejectRatio', 'enterWindows', 'clearWindows']) {
      expect(config.provisional).toContain(`moderation.heuristics.filterEvasion.${key}`)
    }
  })
})
