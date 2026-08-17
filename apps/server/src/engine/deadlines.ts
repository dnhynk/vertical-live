import type { DeadlineRecord, DeadlineStatus } from '../db/types.js'
import type { ScheduledDeadline } from '../world/types.js'
import { deadlineRowIdFor } from './ids.js'

/**
 * Mirrors the world's schedule into the `deadlines` table (spec §10.2: the SQL
 * store is the authority for deadlines).
 *
 * The reducer hands back the *whole* pending set after every step, so the engine
 * writes the difference: everything still pending is upserted as `pending`, and
 * everything that left the set is closed with the reason it left. Rows are keyed
 * by `(kind, key)` through `deadlineRowIdFor`, which is what lets a re-armed
 * timer of the same kind update its row instead of accumulating a new one.
 *
 * The payload is the `ScheduledDeadline` itself, so the row can be read back
 * without the engine having to invert the hashed id.
 */

export type DeadlineOutcome = Exclude<DeadlineStatus, 'pending'>

export function deadlineRowIdOf(deadline: ScheduledDeadline): string {
  return deadlineRowIdFor(deadline.kind, deadline.key)
}

export function toDeadlineRecord(
  deadline: ScheduledDeadline,
  status: DeadlineStatus,
): DeadlineRecord {
  return {
    id: deadlineRowIdOf(deadline),
    kind: deadline.kind,
    dueAt: deadline.dueAt,
    policy: deadline.policy,
    payload: { kind: deadline.kind, key: deadline.key, dueAt: deadline.dueAt },
    status,
  }
}

export interface DeadlineDiffInput {
  readonly previous: readonly ScheduledDeadline[]
  readonly next: readonly ScheduledDeadline[]
  /** Timers delivered to the reducer in this step. */
  readonly fired?: readonly ScheduledDeadline[]
  /** Timers dropped by the `skip`/`coalesce` policies (spec §10.2). */
  readonly expired?: readonly ScheduledDeadline[]
}

/**
 * Rows to upsert for one commit. A timer that left the pending set without
 * having fired or expired was cancelled by the world (a mission that completed
 * early removes its close timer), and is recorded as such rather than dropped —
 * the table is an operational record, so a row must never just disappear.
 */
export function deadlineTableDiff(input: DeadlineDiffInput): DeadlineRecord[] {
  const records = new Map<string, DeadlineRecord>()

  const close = (deadline: ScheduledDeadline, status: DeadlineOutcome): void => {
    const record = toDeadlineRecord(deadline, status)
    records.set(record.id, record)
  }

  for (const deadline of input.fired ?? []) close(deadline, 'fired')
  for (const deadline of input.expired ?? []) close(deadline, 'expired')

  const nextIds = new Set(input.next.map(deadlineRowIdOf))
  for (const deadline of input.previous) {
    const id = deadlineRowIdOf(deadline)
    if (nextIds.has(id) || records.has(id)) continue
    close(deadline, 'cancelled')
  }

  // Pending wins over any closure recorded above: a `skip` occurrence that was
  // expired and immediately re-armed is one row, and its live state is pending.
  for (const deadline of input.next) {
    const record = toDeadlineRecord(deadline, 'pending')
    records.set(record.id, record)
  }

  return [...records.values()]
}
