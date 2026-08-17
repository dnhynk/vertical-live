import type { HealthDetailValue } from '../../health/types.js'

/**
 * The two hooks spec §9.1 asks for when a broadcast limit cannot be recovered
 * from: "기존 방송 복구를 먼저 시도하고 불가능하면 `safe_stopped`와 알림으로 전환한다".
 *
 * This module defines the interfaces and nothing else. T12 owns the supervisor
 * state machine and the Discord `AlertSink` (BOARD D-3); wiring a real sink here
 * would put the alert transport inside the broadcast module and make T10 the owner
 * of a decision it does not make.
 */

export type BroadcastAlertKind =
  /** A channel-level live limit was hit (spec §9.1 (1)(2)(3)). */
  | 'broadcast_limit'
  /** An existing broadcast was adopted instead of creating a new one. */
  | 'broadcast_recovered'
  /** `invalidAutoStart`: the transition path is used from here on (spec §4). */
  | 'auto_start_unsupported'
  /** Automatic recovery is not possible; a human is needed. */
  | 'safe_stop_requested'
  /** A mutating call's result was unknown and was reconciled against YouTube. */
  | 'call_reconciled'

export interface BroadcastAlert {
  readonly kind: BroadcastAlertKind
  /** Absolute UTC instant (spec §10.2). */
  readonly at: string
  /** Machine-stable reason, never a response body. */
  readonly reason: string
  readonly detail: Readonly<Record<string, HealthDetailValue>>
}

export type BroadcastAlertSink = (alert: BroadcastAlert) => void

export const nullBroadcastAlertSink: BroadcastAlertSink = () => {}

/** Test double; also what T12 can use before the Discord sink exists. */
export class RecordingBroadcastAlertSink {
  readonly alerts: BroadcastAlert[] = []

  readonly sink: BroadcastAlertSink = (alert) => {
    this.alerts.push(alert)
  }

  ofKind(kind: BroadcastAlertKind): BroadcastAlert[] {
    return this.alerts.filter((alert) => alert.kind === kind)
  }
}

/**
 * Asks the supervisor for `safe_stopped` (spec §9.2). The broadcast module never
 * restarts itself out of this state: re-entering it is a human decision (§9.1).
 */
export interface SafeStopRequest {
  readonly at: string
  readonly reason: string
  readonly detail: Readonly<Record<string, HealthDetailValue>>
}

export type SafeStopRequestSink = (request: SafeStopRequest) => void

export const nullSafeStopRequestSink: SafeStopRequestSink = () => {}
