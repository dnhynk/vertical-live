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

/** Rejection codes that only exist because the consent commands do (BOARD D-9). */
const CONSENT_REJECTION_REASONS = ['consent_disabled'] as const

type ConsentRejectionReason = (typeof CONSENT_REJECTION_REASONS)[number]

/** Every code the snapshot has always carried, consent aside. */
type BaseRejectionReason = Exclude<RejectionReason, ConsentRejectionReason>

/**
 * Per-code rejection counts. The consent code appears **only while the consent
 * gate is open**; closed, the rejection is still in `rejected` and the object is
 * the one this metric published before D-9 (see `CommandMetricsSnapshot`).
 */
export type CommandRejectionCounts = Readonly<Record<BaseRejectionReason, number>> &
  Readonly<Partial<Record<ConsentRejectionReason, number>>>

/**
 * The snapshot. **Its shape follows the gate** (review round 1, M1).
 *
 * TASK_SPECS §T20b requires the closed configuration to be unchanged, and a
 * `/metrics` document with three new fields in it is not unchanged — an operator
 * diffing before and after D-9 would see a feature that is switched off. So the
 * consent fields are present exactly when the gate they describe is open, which
 * is also the only time any of them can be non-zero.
 */
export interface CommandMetricsSnapshot {
  /** Messages whose first token was in the allowlist, accepted or not. */
  readonly commandLike: number
  /** Accepted **world** commands. Consent commands are counted separately. */
  readonly accepted: number
  readonly rejected: number
  readonly rejectedByReason: CommandRejectionCounts
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
   * is structurally 0 — the parser refuses `JOIN`/`LEAVE` — so the ratio is the
   * one this metric reported before D-9.
   */
  readonly commandSuccessRatio: number | null
  /** Accepted `JOIN`/`LEAVE` (BOARD D-9). Anonymous count, gate-open only. */
  readonly consentAccepted?: number
  /**
   * Commands a consented viewer's cooldown or one-vote rule dropped (D-9).
   * Gate-open only: nothing can be suppressed while no message carries an actor.
   */
  readonly suppressed?: number
}

export interface CommandMetricsOptions {
  /**
   * `engine.identityGateOpen` in the consent-mode meaning of BOARD D-9. Defaults
   * to closed, which is also the shape every pre-D-9 caller expects.
   */
  readonly consentGateOpen?: boolean
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
  #suppressed = 0
  #windowsClosed = 0
  #windowContributions = 0
  readonly #consentGateOpen: boolean

  constructor(options: CommandMetricsOptions = {}) {
    this.#consentGateOpen = options.consentGateOpen === true
  }

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
    } else if (admission.disposition === 'suppressed') {
      this.#suppressed += 1
    } else {
      this.#aggregated += 1
    }
  }

  recordWindow(window: AggregateWindowResult): void {
    this.#windowsClosed += 1
    this.#windowContributions += window.acceptedCount
  }

  snapshot(): CommandMetricsSnapshot {
    const base: CommandMetricsSnapshot = {
      commandLike: this.#commandLike,
      accepted: this.#accepted,
      rejected: this.#rejected,
      rejectedByReason: this.#reasonCounts(),
      directApplied: this.#directApplied,
      aggregated: this.#aggregated,
      windowsClosed: this.#windowsClosed,
      windowContributions: this.#windowContributions,
      commandSuccessRatio:
        this.#commandLike === 0
          ? null
          : (this.#accepted + this.#consentAccepted) / this.#commandLike,
    }
    if (!this.#consentGateOpen) return base
    return { ...base, consentAccepted: this.#consentAccepted, suppressed: this.#suppressed }
  }

  /**
   * The per-code counts, minus the consent code while the gate is closed.
   *
   * The code itself still exists closed — a viewer typing `なのる` is refused
   * with `consent_disabled` — and that rejection is still in `rejected`. What it
   * does not get is a key of its own, because the closed configuration publishes
   * the document it published before D-9.
   */
  #reasonCounts(): CommandRejectionCounts {
    if (this.#consentGateOpen) return { ...this.#rejectedByReason }
    const counts: Partial<Record<RejectionReason, number>> = {}
    for (const reason of REJECTION_REASONS) {
      if (CONSENT_REJECTION_REASONS.includes(reason as ConsentRejectionReason)) continue
      counts[reason] = this.#rejectedByReason[reason]
    }
    return counts as CommandRejectionCounts
  }

  reset(): void {
    this.#commandLike = 0
    this.#accepted = 0
    this.#consentAccepted = 0
    this.#rejected = 0
    this.#rejectedByReason = emptyReasonCounts()
    this.#directApplied = 0
    this.#aggregated = 0
    this.#suppressed = 0
    this.#windowsClosed = 0
    this.#windowContributions = 0
  }
}
