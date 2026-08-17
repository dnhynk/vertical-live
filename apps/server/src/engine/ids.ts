import { createHash } from 'node:crypto'

import { DeadlineIdSchema, EffectIdSchema, type DeadlineId, type EffectId } from '@vl/contract'

/**
 * Identifier issuance for the single writer.
 *
 * Both schemes are **derived, not random**: replaying the same inbox from an
 * empty database has to produce the same ids, or the replay determinism of
 * TASK_SPECS §T8 acceptance 1 would only hold for the state and not for the
 * outbox, and a republish after a restart could not be recognized as the same
 * effect (spec §7.3(7)).
 */

/**
 * `e{revision}_{index}`. The revision is unique per commit (the store rejects a
 * revision that does not advance) and the index is the effect's position inside
 * that commit, so the pair is unique without a counter of its own.
 */
export function effectIdFor(revision: number, index: number): EffectId {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RangeError(`effect id revision must be a non-negative integer: ${String(revision)}`)
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`effect id index must be a non-negative integer: ${String(index)}`)
  }
  return EffectIdSchema.parse(`e${String(revision)}_${String(index)}`)
}

/**
 * Row id of a scheduled deadline: `{kind}` when it is the only timer of its
 * kind, `{kind}_{sha256(key)[0:16]}` when a key discriminates several.
 *
 * The key is hashed rather than embedded because it can be an event key, which
 * carries `:` — a character `DeadlineIdSchema` excludes precisely so a deadline
 * id can never spell an event key. The hash keeps the id inside the 128-char
 * bound for any key length, and the full `ScheduledDeadline` (key included) is
 * stored in the row's payload, so nothing is lost by not being able to invert it.
 */
export function deadlineRowIdFor(kind: string, key: string | null): DeadlineId {
  const suffix = key === null ? '' : `_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
  return DeadlineIdSchema.parse(`${kind}${suffix}`)
}
