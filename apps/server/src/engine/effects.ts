import { CONTRACT_VERSION, EffectSchema, type Effect } from '@vl/contract'

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
 */

export interface EffectAssemblyContext {
  /** Revision the transition is being committed at. */
  readonly revision: number
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
