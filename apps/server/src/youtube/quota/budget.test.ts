import { describe, expect, it } from 'vitest'

import { loadSupervisorConfig } from '../../supervisor/config.js'
import { loadBroadcastConfig } from '../broadcast/config.js'
import { loadChatConfig } from '../chat/config.js'
import { FakeClock } from '../../testing/fake-clock.js'
import {
  CHAT_TRANSPORT_SIGNAL,
  buildChatHealthSignals,
  type ChatObservation,
} from '../chat/health.js'
import { quotaCostOf } from './costs.js'
import { loadQuotaConfig } from './config.js'

/** A source part-way through the shipped pacing floor, with nothing wrong. */
function pacedObservation(floorMs: number): ChatObservation {
  return {
    mode: 'grpc',
    liveChatId: 'chat_budget_test',
    connected: false,
    channelState: 'IDLE',
    keepalive: { timeMs: 300_000, timeoutMs: 20_000, permitWithoutCalls: false },
    lastResponseAtUtc: '2026-08-29T09:00:00.000Z',
    lastResponseAtMonotonicMs: 0,
    consecutiveFailures: 0,
    retryBudgetExhausted: false,
    lastError: null,
    offlineAt: null,
    stopped: null,
    reconnect: {
      count: 1,
      lastAt: '2026-08-29T09:00:00.000Z',
      gapMs: null,
      resumedWithToken: true,
      tokenRejected: false,
      tokenRejections: 0,
      lastTokenRejectedAt: null,
      reconnectsWithoutToken: 0,
      estimatedDuplicates: 0,
      estimatedLostMessages: 0,
      wait: {
        reason: 'quota_start_pacing',
        startedAt: '2026-08-29T09:00:00.000Z',
        startedAtMonotonicMs: 0,
        delayMs: floorMs,
      },
    },
    pageToken: null,
    userEvents: { lastAtUtc: null, lastAtMonotonicMs: null, total: 0 },
  }
}

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
 * **Fitting the allowance is necessary and not sufficient.** The 25,000ms floor
 * passes every assertion below — 8,700 projected against 9,500 usable — and
 * still took the broadcast down twice, on 2026-08-24 and 2026-08-28. On
 * 2026-08-29 a restart proved why: in the same Pacific day, with the local
 * counter at 4,712 of 10,000, `liveBroadcasts.insert`/`bind`/`transition`
 * all succeeded while `liveChatMessages.streamList` alone came back
 * `rateLimitExceeded` (gRPC RESOURCE_EXHAUSTED) after seven calls. That method
 * carries a limit of its own that the shared unit budget does not describe, and
 * nothing in this file can see it. The daily call counts either side of the two
 * failures — 794 and 865 fine, 1,584 and ~1,695 refused — put that ceiling
 * somewhere near a thousand a day (T54, A-T54-1).
 *
 * **Raising the floor needed the signal fixed first.** The first attempt on
 * 2026-08-29 put the floor at 90,000ms and the broadcast started dying a
 * different way within three minutes: the chat source waits out its floor with
 * the stream closed, so `chat_transport` went unobservable for the 60s the wait
 * exceeds `signalStaleAfterMs`, the supervisor read a healthy deliberate wait as
 * an outage, and one of `chat-source`'s three restarts was spent before the
 * floor was put back. `youtube/chat/health.ts` now reports a pacing wait that is
 * inside its own delay as `ok`, which is what makes a floor above the staleness
 * window safe. The test below holds those two together.
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

  // Not derived from an interval any more (T54): the interval moves with whether
  // anyone is typing, and what bounds the day is the budget guard in
  // `grpc-source.ts`. The worst case it permits is the whole allowance plus the
  // burst it may run ahead by, and that is the number the platform sees.
  const grpcStartsPerDay = chat.dailyStartBudget + chat.burstStarts
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
    expect(grpcStartsPerDay).toBe(860)
    expect(healthUnits).toBe(4608)
    expect(rolloverUnits).toBe(636)
    expect(projected).toBe(6104)
    expect(projected).toBeLessThanOrEqual(budget)
  })

  it('keeps more than one modeled rollover buffer as usable-budget headroom', () => {
    const usableBudgetHeadroom = budget - projected
    expect(usableBudgetHeadroom).toBe(3396)
    expect(usableBudgetHeadroom).toBeGreaterThan(rolloverUnits)
  })

  /**
   * The two limits the pacing sits between, and how it satisfies both.
   *
   * The platform refuses `liveChatMessages.streamList` somewhere near a thousand
   * calls a day - 794 and 865 were served, 1,584 and ~1,695 were refused. A
   * viewer who has just typed, meanwhile, is waiting on the screen changing, and
   * a ninety-second wait for that is not a product.
   *
   * Neither is met by picking one interval. The source runs a short interval
   * while a user event is recent and a long one otherwise, and a budget guard
   * bounds the day: it may run at most `burstStarts` ahead of the starts earned
   * by this point in the quota day, and past that the interval widens to spread
   * what is left over the rest of the day. So the worst case is
   * `dailyStartBudget + burstStarts` - asserted here against the highest daily
   * count the platform actually served.
   *
   * The floor may exceed `signalStaleAfterMs` because `youtube/chat/health.ts`
   * reports a pacing wait inside its delay as `ok`. **That is the only reason a
   * long interval is safe**, so the two are asserted together.
   */
  /**
   * The idle floor is not free of the budget: it is what the source spends all
   * the hours nobody is typing, and if that alone outruns `dailyStartBudget` the
   * guard is permanently engaged and `burstStarts` is never available for the
   * moments it exists for.
   *
   * Shipped at 90,000ms it did exactly that — 960 idle starts a day against a
   * budget of 800 — and on the live host the source sat 121 starts ahead of its
   * line with the burst locked out while a viewer was typing. Measured
   * 2026-08-29: spent 322, earned 201, guard engaged, interval 124,803ms.
   */
  it('leaves the burst for activity: idling alone stays inside the daily budget', () => {
    const idleStartsPerDay = MS_PER_DAY / chat.grpcStreamMinStartIntervalMs
    expect(idleStartsPerDay).toBeLessThan(chat.dailyStartBudget)
  })

  it('bounds the day under what the platform served, and stays observable while it waits', () => {
    const HIGHEST_DAY_SERVED = 865
    const LOWEST_DAY_REFUSED = 1584
    expect(grpcStartsPerDay).toBeLessThan(HIGHEST_DAY_SERVED)
    expect(grpcStartsPerDay).toBeLessThan(LOWEST_DAY_REFUSED)

    // A viewer who just typed is answered well inside the idle floor.
    expect(chat.activeStreamMinStartIntervalMs).toBeLessThan(chat.grpcStreamMinStartIntervalMs)

    // The idle floor is longer than the staleness window, on purpose.
    expect(chat.grpcStreamMinStartIntervalMs).toBeGreaterThan(supervisor.signalStaleAfterMs)

    // And the transport signal covers exactly that gap.
    const clock = new FakeClock({ monotonicStartMs: chat.grpcStreamMinStartIntervalMs - 1 })
    const signals = buildChatHealthSignals(
      pacedObservation(chat.grpcStreamMinStartIntervalMs),
      clock,
    )
    const transport = signals.find((signal) => signal.name === CHAT_TRANSPORT_SIGNAL)
    expect(transport?.status).toBe('ok')
    expect(transport?.reason).toBe('quota_start_pacing')
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
