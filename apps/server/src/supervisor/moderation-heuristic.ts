import type { Clock } from '../clock.js'
import type { CommandMetricsSnapshot } from '../input/metrics.js'
import type { RejectionReason } from '../input/types.js'

/**
 * The one automatic reporter of spec §12.3 (TASK_SPECS §T22).
 *
 * Of the four call-table reasons (BOARD D-13) exactly one is observable without
 * reading chat: `filter_evasion_surge`. The other three — targeted harassment,
 * exposed personal data, sexual or self-harm risk — are judgements about what a
 * message *means*, and this process deliberately keeps no message to judge
 * (§7.3(1), §12.3). **They are not detected here and must not be**; they arrive
 * through `POST /admin/moderation` when a person decides (see
 * `moderation-report.ts` and `docs/ops/moderation-call-table.md` §2).
 *
 * ## What is measured
 *
 * `moderation-call-table.md` §2 defines the token as "금칙어·URL 필터를 우회하는
 * 변형 입력이 급증해 자동 차단이 사실상 무력해졌다". The approved automatic
 * block scope (call table §1, item 4) is YouTube's own filters — blocked words,
 * URL hold, hold for review, slow mode — so a message carrying a link or a
 * banned term that still reaches this parser is a message those filters did not
 * hold. That is precisely what `moderate()` (`input/moderation.ts`) reports, and
 * it reports it *after* undoing obfuscation: `example(dot)com`, `ｈｘｘｐ`,
 * `www-example-com`, homoglyphs, combining marks and repeat-padding are folded
 * before the match. A rejection with one of those codes is therefore already an
 * observation of a **variant spelling that got past the filter**.
 *
 * The shape and gate codes are excluded for the opposite reason: `no_command`
 * is every ordinary chat line, `too_long` is a long one, and
 * `extraneous_text`/`invalid_argument`/`vote_disabled`/`consent_disabled` are
 * everyday mistakes. Counting them would keep this detector permanently above
 * any threshold — and because D-13 made `filter_evasion_surge` a safe-stop
 * condition, a false positive here stops the broadcast.
 *
 * (Coordinator `ask`, 2026-08-20: option A approved, with the full 14-code table
 * recorded in `docs/tasks/TASK-T22-moderation-report.md`.)
 */

/**
 * The rejection codes `moderate()` produces — every one of them, and nothing
 * else. Kept as a literal list rather than derived at runtime so that adding a
 * moderation category is a decision someone makes here too; `input` owns the
 * codes and a test pins this list against them.
 */
export const FILTER_EVASION_REJECTION_REASONS: readonly RejectionReason[] = [
  'url',
  'personal_data',
  'banned_hate',
  'banned_sexual',
  'banned_self_harm',
  'banned_violence',
  'banned_ads_scam',
]

/**
 * `supervisor.moderation.heuristics.filterEvasion`. Every number is
 * **provisional** (BOARD A-15/D-14): there is no live traffic to calibrate
 * against yet, so these are starting values marked as such in
 * `config/default.json`, not a pass line.
 */
export interface FilterEvasionHeuristicConfig {
  readonly enabled: boolean
  /** Length of one aggregation window, monotonic (spec §10.2). */
  readonly windowMs: number
  /**
   * Fewest parsed messages a window must carry before its ratio counts.
   *
   * The denominator is **messages that reached the parser**, not the
   * command-like subset: an evasion attempt is usually not a command at all, so
   * dividing by `commandLike` would compare two different populations and
   * produce an unbounded number. Over all parsed messages the ratio is a real
   * proportion in [0,1] — "this share of the chat is filter-evading" — and it
   * normalizes for how busy the channel is.
   */
  readonly minMessages: number
  /** Share of parsed messages rejected as evasion before a window counts. */
  readonly rejectRatio: number
  /** Consecutive exceeding windows before the reason is reported (N). */
  readonly enterWindows: number
  /** Consecutive non-exceeding windows before it is cleared (M). */
  readonly clearWindows: number
}

/** One closed window. Integers and a ratio — nothing derived from a message. */
export interface FilterEvasionWindow {
  readonly atUtc: string
  readonly elapsedMs: number
  /** Parsed messages in the window: accepted + consent-accepted + rejected. */
  readonly messages: number
  readonly evasionRejections: number
  /** `evasionRejections / messages`, or `null` for an empty window. */
  readonly ratio: number | null
  readonly exceeded: boolean
}

/** What `/health` shows about the detector. */
export interface FilterEvasionState {
  readonly enabled: boolean
  /** True while this detector's report stands (it has not cleared it). */
  readonly reported: boolean
  readonly consecutiveExceeding: number
  readonly consecutiveBelow: number
  readonly windowsClosed: number
  readonly lastWindow: FilterEvasionWindow | null
}

/** `report` on entry, `clear` on exit, `null` while nothing changed. */
export type FilterEvasionVerdict = 'report' | 'clear' | null

export interface FilterEvasionDetectorOptions {
  readonly config: FilterEvasionHeuristicConfig
  readonly clock: Clock
  /** Cumulative input counters; the detector takes its own differences. */
  readonly metrics: () => CommandMetricsSnapshot
}

/**
 * Samples the cumulative input counters at window boundaries and decides
 * whether the reason should be reported.
 *
 * It holds no state of its own beyond two counters and the previous sample, and
 * it is driven by the supervisor's evaluation loop rather than a timer of its
 * own — so when the run reaches `safe_stopped` and that loop stops, this stops
 * with it (spec §9.2).
 */
export class FilterEvasionDetector {
  readonly #config: FilterEvasionHeuristicConfig
  readonly #clock: Clock
  readonly #metrics: () => CommandMetricsSnapshot

  #windowStartMs: number | null = null
  #baseline: { messages: number; evasion: number } | null = null
  #consecutiveExceeding = 0
  #consecutiveBelow = 0
  #windowsClosed = 0
  #reported = false
  #lastWindow: FilterEvasionWindow | null = null

  constructor(options: FilterEvasionDetectorOptions) {
    this.#config = options.config
    this.#clock = options.clock
    this.#metrics = options.metrics
  }

  state(): FilterEvasionState {
    return {
      enabled: this.#config.enabled,
      reported: this.#reported,
      consecutiveExceeding: this.#consecutiveExceeding,
      consecutiveBelow: this.#consecutiveBelow,
      windowsClosed: this.#windowsClosed,
      lastWindow: this.#lastWindow,
    }
  }

  /**
   * Called on every supervisor evaluation. Closes a window when `windowMs` has
   * passed on the monotonic clock and returns the verdict for that window.
   */
  observe(): FilterEvasionVerdict {
    if (!this.#config.enabled) return null
    const nowMs = this.#clock.monotonicMs()
    const sample = readSample(this.#metrics())

    if (this.#windowStartMs === null || this.#baseline === null) {
      this.#windowStartMs = nowMs
      this.#baseline = sample
      return null
    }

    const elapsedMs = nowMs - this.#windowStartMs
    if (elapsedMs < this.#config.windowMs) return null

    // A counter that went backwards means the collector was reset, not that
    // messages were un-received: the window is re-based instead of producing a
    // negative rate.
    const messages = Math.max(0, sample.messages - this.#baseline.messages)
    const evasion = Math.max(0, sample.evasion - this.#baseline.evasion)
    this.#windowStartMs = nowMs
    this.#baseline = sample
    this.#windowsClosed += 1

    const ratio = messages === 0 ? null : evasion / messages
    const exceeded =
      messages >= this.#config.minMessages &&
      ratio !== null &&
      ratio >= this.#config.rejectRatio
    this.#lastWindow = {
      atUtc: this.#clock.nowUtcIso(),
      elapsedMs,
      messages,
      evasionRejections: evasion,
      ratio,
      exceeded,
    }

    if (exceeded) {
      this.#consecutiveBelow = 0
      this.#consecutiveExceeding += 1
      if (!this.#reported && this.#consecutiveExceeding >= this.#config.enterWindows) {
        this.#reported = true
        return 'report'
      }
      return null
    }

    this.#consecutiveExceeding = 0
    this.#consecutiveBelow += 1
    if (this.#reported && this.#consecutiveBelow >= this.#config.clearWindows) {
      this.#reported = false
      return 'clear'
    }
    return null
  }
}

/**
 * One reading of the cumulative counters.
 *
 * `consentAccepted` exists in the snapshot only while the consent gate is open
 * (BOARD D-9 — `input/metrics.ts` publishes the pre-D-9 document while it is
 * closed), and the per-code counts lose the `consent_disabled` key with it. Both
 * are read defensively so the detector computes the same thing in either
 * identity mode (§T22 acceptance 2).
 */
function readSample(snapshot: CommandMetricsSnapshot): { messages: number; evasion: number } {
  const messages = snapshot.accepted + (snapshot.consentAccepted ?? 0) + snapshot.rejected
  let evasion = 0
  for (const reason of FILTER_EVASION_REJECTION_REASONS) {
    evasion += snapshot.rejectedByReason[reason] ?? 0
  }
  return { messages, evasion }
}
