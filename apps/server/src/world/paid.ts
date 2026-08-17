import type { CanonicalEvent, Identifier, IsoUtcInstant, PaidEventKind } from '@vl/contract'

import type { WorldTuning } from './content/tuning.js'
import { addMillis, millisBetween } from './time.js'
import type {
  AuditState,
  EventCause,
  InputRejection,
  PaidThanksDraft,
  PendingThanks,
  ScheduledDeadline,
  WorldTransition,
} from './types.js'
import { scheduleDeadline } from './deadlines.js'

/**
 * Paid events (spec §8.4, §8.5, §9.2).
 *
 * Payment buys a fixed, pre-described thanks and nothing else. The rule is
 * enforced by the shape of this module rather than by discipline:
 *
 * - `applyPaidEvent` takes an `AuditState`, not a `GameState`, and returns an
 *   `AuditState`. It is *unable* to produce world state, so it cannot move a
 *   need, a mission, a growth step, a tally or a branch (spec §8.5).
 * - it takes no `Rng`. Consuming a draw would shift every later draw in the
 *   step, which would make a payment change the world's probabilities — the
 *   same prohibition, one level less obvious.
 * - the thanks staging is chosen by a fixed table keyed on the paid kind, so two
 *   identical paid events always stage identically regardless of world state.
 *
 * `paid.test.ts` covers the property from the outside as well: interleaving
 * arbitrary paid events into a run leaves `state.world` referentially identical.
 */

/** Fixed thanks icons (spec §8.4 "안전한 아이콘"). Never a supporter name. */
export const PAID_THANKS_ICONS: Readonly<Record<PaidEventKind, Identifier>> = {
  SUPER_CHAT: 'thanks_super_chat',
  SUPER_STICKER: 'thanks_super_sticker',
  GIFT: 'thanks_gift',
  MEMBERSHIP: 'thanks_membership',
}

const PAID_EVENT_KINDS: Readonly<Record<string, PaidEventKind>> = {
  SUPER_CHAT: 'SUPER_CHAT',
  SUPER_STICKER: 'SUPER_STICKER',
  GIFT: 'GIFT',
  MEMBERSHIP: 'MEMBERSHIP',
}

export function paidEventKindOf(event: CanonicalEvent): PaidEventKind | null {
  return PAID_EVENT_KINDS[event.kind] ?? null
}

export interface PaidResult {
  readonly audit: AuditState
  readonly effects: readonly PaidThanksDraft[]
  readonly transitions: readonly WorldTransition[]
  readonly rejections: readonly InputRejection[]
}

/**
 * The substitute-thanks timers, derived from the audit state rather than stored
 * in the world's schedule. Keeping them out of `GameState` is what makes "a paid
 * event never touches world state" a referential fact and not a convention
 * (spec §8.5); the engine sees them in `StepResult.deadlines` all the same.
 */
export function paidFallbackDeadlines(audit: AuditState): readonly ScheduledDeadline[] {
  return audit.pendingThanks.map((pending) =>
    scheduleDeadline('paid_thanks_fallback', pending.fallbackAt, pending.eventKey),
  )
}

/**
 * Stages the acknowledgement for one paid event.
 *
 * When the event reaches the world later than its staging window allowed — the
 * degraded-window case of spec §9.2 — the original staging is already gone, so
 * the substitute thanks runs immediately instead, exactly once.
 */
export function applyPaidEvent(
  audit: AuditState,
  event: CanonicalEvent,
  paidEventKind: PaidEventKind,
  now: IsoUtcInstant,
  tuning: WorldTuning,
): PaidResult {
  if (audit.acknowledgedEventKeys.includes(event.eventKey)) {
    return {
      audit,
      effects: [],
      transitions: [],
      rejections: [{ reason: 'duplicate_paid_event', eventKey: event.eventKey, at: now }],
    }
  }

  const cause: EventCause = { kind: 'event', eventKey: event.eventKey }
  const iconId = PAID_THANKS_ICONS[paidEventKind]
  const tier = event.payment?.tier ?? null
  const lateBy = millisBetween(now, event.occurredAt)
  const late = lateBy > tuning.paid.originalStagingWindowMs

  const effect: PaidThanksDraft = {
    kind: 'PAID_THANKS',
    paid: true,
    cause,
    variantId: iconId,
    startsAt: now,
    endsAt: addMillis(
      now,
      late ? tuning.paid.fallbackDurationMs : tuning.paid.thanksDurationMs,
    ),
    payload: { paidEventKind, iconId, tier, fallback: late },
  }

  const transition: WorldTransition = {
    type: 'paid_acknowledged',
    at: now,
    variantId: iconId,
    from: null,
    to: late ? 'fallback' : 'original',
    cause: 'paid',
    sceneKey: null,
  }

  const acknowledged = [...audit.acknowledgedEventKeys, event.eventKey].slice(
    -tuning.paid.acknowledgedRingSize,
  )

  // A late acknowledgement is already the substitute run, so nothing is owed.
  if (late) {
    return {
      audit: { pendingThanks: audit.pendingThanks, acknowledgedEventKeys: acknowledged },
      effects: [effect],
      transitions: [transition],
      rejections: [],
    }
  }

  const pending: PendingThanks = {
    eventKey: event.eventKey,
    paidEventKind,
    tier,
    iconId,
    stagedAt: now,
    fallbackAt: addMillis(now, tuning.paid.originalStagingWindowMs),
  }
  return {
    audit: {
      pendingThanks: [...audit.pendingThanks, pending],
      acknowledgedEventKeys: acknowledged,
    },
    effects: [effect],
    transitions: [transition],
    rejections: [],
  }
}

/**
 * The engine calls this once the renderer confirmed the original thanks reached
 * a frame (spec §7.3(7)). It clears the substitute obligation and touches audit
 * state only — the same §8.5 guarantee as above.
 */
export function markThanksDelivered(audit: AuditState, eventKey: string): AuditState {
  return {
    ...audit,
    pendingThanks: audit.pendingThanks.filter((it) => it.eventKey !== eventKey),
  }
}

/**
 * Fires when a staged thanks was never confirmed: spec §9.2 owes exactly one
 * substitute acknowledgement, with no game power, and then the obligation ends.
 */
export function applyThanksFallback(
  audit: AuditState,
  eventKey: string,
  now: IsoUtcInstant,
  tuning: WorldTuning,
): PaidResult {
  const pending = audit.pendingThanks.find((it) => it.eventKey === eventKey)
  if (pending === undefined) {
    return { audit, effects: [], transitions: [], rejections: [] }
  }
  const effect: PaidThanksDraft = {
    kind: 'PAID_THANKS',
    paid: true,
    cause: { kind: 'event', eventKey: pending.eventKey },
    variantId: pending.iconId,
    startsAt: now,
    endsAt: addMillis(now, tuning.paid.fallbackDurationMs),
    payload: {
      paidEventKind: pending.paidEventKind,
      iconId: pending.iconId,
      tier: pending.tier,
      fallback: true,
    },
  }
  return {
    audit: markThanksDelivered(audit, eventKey),
    effects: [effect],
    transitions: [
      {
        type: 'paid_acknowledged',
        at: now,
        variantId: pending.iconId,
        from: 'pending',
        to: 'fallback',
        cause: 'paid',
        sceneKey: null,
      },
    ],
    rejections: [],
  }
}
