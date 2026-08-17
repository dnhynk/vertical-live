import { describe, expect, it } from 'vitest'

import { scheduleDeadline } from '../world/deadlines.js'
import { deadlineRowIdOf, deadlineTableDiff, toDeadlineRecord } from './deadlines.js'

/**
 * Mirroring the world's schedule into the `deadlines` table (spec §10.2). The
 * table is the operational record, so a timer that leaves the pending set has to
 * leave a reason behind rather than simply disappearing.
 */

const idle = scheduleDeadline('idle_beat', '2026-08-16T00:01:00.000Z')
const idleLater = scheduleDeadline('idle_beat', '2026-08-16T00:02:00.000Z')
const beatSetup = scheduleDeadline('chapter_beat', '2026-08-16T00:00:00.000Z', 'setup')
const beatTurn = scheduleDeadline('chapter_beat', '2026-08-16T06:00:00.000Z', 'turn')
const mission = scheduleDeadline('mission_close', '2026-08-16T00:20:00.000Z')

describe('deadlineTableDiff', () => {
  it('carries the policy from the content definition onto the row', () => {
    expect(toDeadlineRecord(idle, 'pending').policy).toBe('skip')
    expect(toDeadlineRecord(beatSetup, 'fired').policy).toBe('replay')
    expect(toDeadlineRecord(mission, 'pending').policy).toBe('coalesce')
  })

  it('keys a row by (kind, key) so a re-armed timer updates its own row', () => {
    expect(deadlineRowIdOf(idle)).toBe(deadlineRowIdOf(idleLater))
    expect(deadlineRowIdOf(beatSetup)).not.toBe(deadlineRowIdOf(beatTurn))

    const rows = deadlineTableDiff({
      previous: [idle],
      next: [idleLater],
      fired: [idle],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')
    expect(rows[0]?.dueAt).toBe(idleLater.dueAt)
  })

  it('records a delivered timer that was not re-armed as fired', () => {
    const rows = deadlineTableDiff({ previous: [beatSetup], next: [], fired: [beatSetup] })

    expect(rows).toEqual([expect.objectContaining({ status: 'fired', kind: 'chapter_beat' })])
  })

  it('records a policy-dropped occurrence as expired', () => {
    const rows = deadlineTableDiff({ previous: [idle], next: [], expired: [idle] })

    expect(rows[0]?.status).toBe('expired')
  })

  it('records a timer the world removed as cancelled, never as gone', () => {
    const rows = deadlineTableDiff({ previous: [mission, idle], next: [idle] })

    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.kind === 'mission_close')?.status).toBe('cancelled')
    expect(rows.find((row) => row.kind === 'idle_beat')?.status).toBe('pending')
  })

  it('stores the schedule in the payload so the row can be read back', () => {
    const record = toDeadlineRecord(beatTurn, 'pending')

    expect(record.payload).toEqual({
      kind: 'chapter_beat',
      key: 'turn',
      dueAt: beatTurn.dueAt,
    })
  })
})
