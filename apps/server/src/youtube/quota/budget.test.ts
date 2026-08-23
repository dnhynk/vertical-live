import { describe, expect, it } from 'vitest'

import { loadSupervisorConfig } from '../../supervisor/config.js'
import { loadBroadcastConfig } from '../broadcast/config.js'
import { quotaCostOf } from './costs.js'
import { loadQuotaConfig } from './config.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The polling intervals are not free choices. On 2026-08-23 the repository
 * defaults spent the whole daily allowance on the health poll alone —
 * `liveStreams.list` + `liveBroadcasts.list` every 15s is 11,520 units a day
 * against an allowance of 10,000 — and the broadcast stayed down until the
 * Pacific-midnight reset (T44).
 *
 * These are arithmetic, not opinion, so they are a test rather than a comment.
 * A future change that shortens an interval or adds a call to the poll fails
 * here instead of eighteen hours later on the host.
 */
describe('the repository defaults fit one day of quota', () => {
  const quota = loadQuotaConfig()
  const broadcast = loadBroadcastConfig()
  const supervisor = loadSupervisorConfig()

  const streamPollsPerDay = MS_PER_DAY / broadcast.healthPollIntervalMs
  const reconcilesPerDay = MS_PER_DAY / broadcast.lifecycleReconcileIntervalMs
  const healthUnits =
    streamPollsPerDay * quotaCostOf('liveStreams.list') +
    reconcilesPerDay * quotaCostOf('liveBroadcasts.list')

  // Measured on the host 2026-08-23: 226 reconnects over 152 minutes of a
  // healthy run. Each opens one `liveChatMessages.streamList`.
  const chatReconnectsPerMinute = 1.5
  const chatUnits = chatReconnectsPerMinute * 60 * 24 * quotaCostOf('liveChatMessages.streamList')

  // Two 11-hour segments a day (D-21). Each: insert + bind + two transitions,
  // plus the bounded list polls that wait for each transition to settle.
  const settleListsPerTransition = Math.ceil(
    broadcast.transitionSettleMs / broadcast.statusPollIntervalMs,
  )
  const perSegment =
    quotaCostOf('liveBroadcasts.insert') +
    quotaCostOf('liveBroadcasts.bind') +
    2 * quotaCostOf('liveBroadcasts.transition') +
    2 * settleListsPerTransition * quotaCostOf('liveBroadcasts.list')
  const rolloverUnits = 3 * perSegment // two segments plus one retry's worth

  const projected = healthUnits + chatUnits + rolloverUnits
  const budget = quota.dailyUnits - quota.reserveUnits

  it('projects a day inside the allowance, with the reserve untouched', () => {
    expect(projected).toBeLessThan(budget)
  })

  it('keeps enough headroom that a bad day does not end the broadcast', () => {
    // A day with no headroom is a day one extra restart ends. A fifth of the
    // budget is the margin this arithmetic was tuned to leave.
    expect(budget - projected).toBeGreaterThan(budget * 0.2)
  })

  /**
   * The other ceiling. A signal nobody refreshed inside `signalStaleAfterMs` is
   * dropped, and `youtube_broadcast` is a required family, so a health poll
   * slower than that window makes the family unobservable between polls and the
   * supervisor recovers a component that is not broken. Quota pushes this
   * interval up; staleness pushes it down; the two nearly meet.
   */
  it('polls well inside the window that keeps its signal observable', () => {
    expect(broadcast.healthPollIntervalMs).toBeLessThan(supervisor.signalStaleAfterMs)
    expect(broadcast.healthPollIntervalMs).toBeLessThanOrEqual(supervisor.signalStaleAfterMs * 0.75)
  })
})
