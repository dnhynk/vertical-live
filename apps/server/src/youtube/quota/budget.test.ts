import { describe, expect, it } from 'vitest'

import { loadSupervisorConfig } from '../../supervisor/config.js'
import { loadBroadcastConfig } from '../broadcast/config.js'
import { loadChatConfig } from '../chat/config.js'
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
  const chat = loadChatConfig()
  const supervisor = loadSupervisorConfig()

  const streamPollsPerDay = MS_PER_DAY / broadcast.healthPollIntervalMs
  const reconcilesPerDay = MS_PER_DAY / broadcast.lifecycleReconcileIntervalMs
  const healthUnits =
    streamPollsPerDay * quotaCostOf('liveStreams.list') +
    reconcilesPerDay * quotaCostOf('liveBroadcasts.list')

  // T47 replaces the old 1.5/min host observation: YouTube later closed healthy
  // streams around every 10.6s. The shipped start-to-start interval is the
  // deterministic upper bound, including a stream opened at any phase of a day.
  const successfulGrpcStartsPerDay = Math.ceil(MS_PER_DAY / chat.successfulStreamMinStartIntervalMs)
  const chatUnits = successfulGrpcStartsPerDay * quotaCostOf('liveChatMessages.streamList')

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

  it('projects the capped worst-case day inside the allowance, with the reserve untouched', () => {
    expect(successfulGrpcStartsPerDay).toBe(3456)
    expect(projected).toBeLessThanOrEqual(budget)
  })

  it('keeps positive headroom after the capped chat and fixed broadcast budget', () => {
    expect(budget - projected).toBeGreaterThan(0)
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
