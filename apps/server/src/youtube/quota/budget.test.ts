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
 *
 * **Fitting the allowance is necessary and not sufficient.** T47's 25,000ms
 * floor passed every assertion below — 8,700 projected against 9,500 usable —
 * and still took the broadcast down twice, on 2026-08-24 and 2026-08-28. On
 * 2026-08-29 a restart proved why: in the same Pacific day, with the local
 * counter at 4,712 of 10,000, `liveBroadcasts.insert`/`bind`/`transition`
 * all succeeded while `liveChatMessages.streamList` alone came back
 * `rateLimitExceeded` (gRPC RESOURCE_EXHAUSTED) after seven calls. That method
 * carries a limit of its own that the shared unit budget does not describe, and
 * nothing in this file can see it. The daily call counts either side of the two
 * failures — 794 and 865 fine, 1,584 and ~1,695 refused — put that ceiling
 * somewhere near a thousand a day, which is what `grpcStartsPerDay` is now set
 * under. It is an observation, not a documented number (T54, A-T54-1).
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

  // T47 replaces the old 1.5/min host observation: the floor now covers every
  // actual start, including response-then-error, empty, and token-retry paths.
  // `ceil` includes a stream opened at any phase of the modeled day.
  const grpcStartsPerDay = Math.ceil(MS_PER_DAY / chat.grpcStreamMinStartIntervalMs)
  const chatUnits = grpcStartsPerDay * quotaCostOf('liveChatMessages.streamList')

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
    expect(grpcStartsPerDay).toBe(960)
    expect(healthUnits).toBe(4608)
    expect(rolloverUnits).toBe(636)
    expect(projected).toBe(6204)
    expect(projected).toBeLessThanOrEqual(budget)
  })

  it('keeps more than one modeled rollover buffer as usable-budget headroom', () => {
    const usableBudgetHeadroom = budget - projected
    expect(usableBudgetHeadroom).toBe(3296)
    expect(usableBudgetHeadroom).toBeGreaterThan(rolloverUnits)
  })

  /**
   * The constraint the unit budget cannot express. Both days the broadcast died
   * on `rateLimitExceeded` had crossed roughly a thousand `streamList` calls;
   * both days it survived stayed under nine hundred. Until that ceiling is
   * documented or measured against the Cloud Console (A-T54-1), the floor stays
   * under the lower of the two observations that failed.
   */
  it('opens fewer chat streams a day than the two days that were refused', () => {
    const REFUSED_AT_OR_ABOVE = 1584
    const SURVIVED_UP_TO = 865
    expect(grpcStartsPerDay).toBeLessThan(REFUSED_AT_OR_ABOVE)
    expect(grpcStartsPerDay).toBeLessThanOrEqual(SURVIVED_UP_TO * 1.2)
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
