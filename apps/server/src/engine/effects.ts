import { CONTRACT_VERSION, EffectSchema, type ConsentedActor, type Effect } from '@vl/contract'

import type { EffectDraft } from '../world/types.js'
import { effectIdFor } from './ids.js'

/**
 * Effect assembly (BOARD A-17, TASK_SPECS §T8 "Effect 조립").
 *
 * T7 returns drafts: it knows what to stage and why, but not which revision the
 * staging will be committed at, what the effect is called, or which persisted
 * deadline row fired. The engine owns all three, so it is the only place where a
 * contract `Effect` can be built.
 *
 * The two cause rules are re-stated by construction here and re-checked by
 * `EffectSchema.parse` on the way out:
 * - an event cause carries `causedByEventKey = cause.eventKey`;
 * - a deadline cause carries `causedByEventKey = null` (spec §2.1: content moves
 *   with zero viewers, so a timer has no event to point at);
 * - `paid` implies an event cause, which the draft type already guarantees.
 *
 * The consented actor (BOARD D-9) is attached here for the same reason: T7 does
 * not know who sent a command and must not, so the engine adds the name to the
 * one effect allowed to carry it — `ACTION_REACTION` with a single contribution.
 * An aggregated reaction stands for several viewers, so naming one of them would
 * claim participation that is not true (spec §2.6), and a paid effect has no
 * `actor` field at all (spec §8.4).
 */

export interface EffectAssemblyContext {
  /** Revision the transition is being committed at. */
  readonly revision: number
  /**
   * Consented viewer whose command caused this draft, when the engine knows one
   * (BOARD D-9). Held in memory only — the outbox row has no column for it, so a
   * republish after a restart is anonymous.
   */
  readonly actor?: ConsentedActor | null
  /**
   * The deadline row currently being stepped, when one is. Its id is attached to
   * drafts caused by a deadline of the same kind — the engine does not guess a
   * row for a timer it is not delivering.
   */
  readonly deadline?: { readonly kind: string; readonly rowId: string }
}

export function assembleEffects(
  drafts: readonly EffectDraft[],
  context: EffectAssemblyContext,
): Effect[] {
  return drafts.map((draft, index) => assembleEffect(draft, context, index))
}

export function assembleEffect(
  draft: EffectDraft,
  context: EffectAssemblyContext,
  index: number,
): Effect {
  const effectId = effectIdFor(context.revision, index)
  const base = {
    schemaVersion: CONTRACT_VERSION,
    effectId,
    stateRevision: context.revision,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
  }

  if (draft.cause.kind === 'event') {
    return EffectSchema.parse({
      ...base,
      cause: { kind: 'event', eventKey: draft.cause.eventKey },
      causedByEventKey: draft.cause.eventKey,
      kind: draft.kind,
      paid: draft.paid,
      payload: draft.payload,
      ...actorFieldFor(draft, context),
    })
  }

  const sameKind = context.deadline?.kind === draft.cause.deadlineKind
  return EffectSchema.parse({
    ...base,
    cause: {
      kind: 'deadline',
      deadlineKind: draft.cause.deadlineKind,
      ...(sameKind && context.deadline !== undefined ? { deadlineId: context.deadline.rowId } : {}),
    },
    causedByEventKey: null,
    kind: draft.kind,
    paid: draft.paid,
    payload: draft.payload,
  })
}

/**
 * The `actor` field, or nothing at all.
 *
 * Written only for a single-contribution `ACTION_REACTION`: that is the one
 * variant whose schema has the field, and the contract additionally refuses an
 * actor on an aggregated reaction. Returning an empty object rather than
 * `{ actor: null }` keeps every other effect byte-identical to what it was
 * before D-9, which is what makes the closed configuration's fixtures still
 * match (TASK_SPECS §T20b acceptance 1).
 */
function actorFieldFor(
  draft: EffectDraft,
  context: EffectAssemblyContext,
): { actor?: ConsentedActor } {
  const actor = context.actor ?? null
  if (actor === null || draft.kind !== 'ACTION_REACTION') return {}
  const payload = draft.payload as { contributionCount?: number }
  return payload.contributionCount === 1 ? { actor } : {}
}
