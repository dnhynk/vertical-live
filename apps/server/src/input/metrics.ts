import type { AggregateWindowResult, ArbiterAdmission } from './arbiter.js'
import { REJECTION_REASONS, type ParseResult, type RejectionReason } from './types.js'

/**
 * "명령 성공" of spec §14.1: accepted commands over messages that looked like a
 * command. Every counter is an anonymous integer — there is deliberately no
 * per-author breakdown, not even for a consented viewer (BOARD D-9 buys a name
 * on screen and nothing else; a per-person series is the §14.1 D1/D7/D30 metric
 * that stays behind the [S42] approval) — and no message text is retained, so a
 * rejection contributes only its code.
 *
 * The collector is a plain object with no clock and no I/O. T8 owns the engine
 * that feeds it and T12 owns exposing it on `GET /metrics`.
 */

export interface CommandMetricsSnapshot {
  /** Messages whose first token was in the allowlist, accepted or not. */
  readonly commandLike: number
  /** Accepted **world** commands. Consent commands are counted separately. */
  readonly accepted: number
  /** Accepted `JOIN`/`LEAVE` (BOARD D-9). Anonymous count, no breakdown. */
  readonly consentAccepted: number
  readonly rejected: number
  readonly rejectedByReason: Readonly<Record<RejectionReason, number>>
  readonly directApplied: number
  readonly aggregated: number
  readonly windowsClosed: number
  /** Contributions carried by closed windows; proves none were lost (§7.3). */
  readonly windowContributions: number
  /**
   * `(accepted + consentAccepted) / commandLike`, or `null` before any
   * command-like message. Spec §14.1 defines it as "수락된 명령 / 명령처럼 보이는
   * 메시지", and a consent command is an allowlisted command of §7.1, so an
   * accepted one is a success. While the consent gate is closed the second term
   * is always 0 and the ratio is exactly what it was before D-9.
   */
  readonly commandSuccessRatio: number | null
}

function emptyReasonCounts(): Record<RejectionReason, number> {
  const counts = {} as Record<RejectionReason, number>
  for (const reason of REJECTION_REASONS) {
    counts[reason] = 0
  }
  return counts
}

export class CommandMetrics {
  #commandLike = 0
  #accepted = 0
  #consentAccepted = 0
  #rejected = 0
  #rejectedByReason = emptyReasonCounts()
  #directApplied = 0
  #aggregated = 0
  #windowsClosed = 0
  #windowContributions = 0

  recordParse(result: ParseResult): void {
    if (result.commandLike) {
      this.#commandLike += 1
    }
    if (result.status === 'accepted') {
      this.#accepted += 1
      return
    }
    if (result.status === 'accepted_consent') {
      this.#consentAccepted += 1
      return
    }
    this.#rejected += 1
    this.#rejectedByReason[result.reason] += 1
  }

  recordAdmission(admission: ArbiterAdmission): void {
    if (admission.disposition === 'direct') {
      this.#directApplied += 1
    } else {
      this.#aggregated += 1
    }
  }

  recordWindow(window: AggregateWindowResult): void {
    this.#windowsClosed += 1
    this.#windowContributions += window.acceptedCount
  }

  snapshot(): CommandMetricsSnapshot {
    return {
      commandLike: this.#commandLike,
      accepted: this.#accepted,
      consentAccepted: this.#consentAccepted,
      rejected: this.#rejected,
      rejectedByReason: { ...this.#rejectedByReason },
      directApplied: this.#directApplied,
      aggregated: this.#aggregated,
      windowsClosed: this.#windowsClosed,
      windowContributions: this.#windowContributions,
      commandSuccessRatio:
        this.#commandLike === 0
          ? null
          : (this.#accepted + this.#consentAccepted) / this.#commandLike,
    }
  }

  reset(): void {
    this.#commandLike = 0
    this.#accepted = 0
    this.#consentAccepted = 0
    this.#rejected = 0
    this.#rejectedByReason = emptyReasonCounts()
    this.#directApplied = 0
    this.#aggregated = 0
    this.#windowsClosed = 0
    this.#windowContributions = 0
  }
}
