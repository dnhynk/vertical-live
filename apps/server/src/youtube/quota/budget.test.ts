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
   * The two limits this floor sits between, and why it may exceed one of them.
   *
   * The platform refuses `liveChatMessages.streamList` somewhere near a thousand
   * calls a day - 794 and 865 were served, 1,584 and ~1,695 were refused - which
   * is a start every 86 seconds or slower. The supervisor drops a signal nobody
   * refreshed inside `signalStaleAfterMs`, and `chat_transport` is required, so
   * for one day this floor could not be raised without turning every pacing wait
   * into an apparent outage.
   *
   * `youtube/chat/health.ts` closed that: a `quota_start_pacing` wait inside its
   * own delay reports the transport `ok`, because a source honouring its floor
   * is a source that is working. **That is the only reason a floor above the
   * staleness window is safe**, so the two are asserted together - if the signal
   * ever stops covering the wait, this pairing is where it shows up.
   */
  it('paces under the platform limit, and only because a paced wait reports ok', () => {
    const OBSERVED_DAILY_CEILING = 1000
    expect(grpcStartsPerDay).toBeLessThan(OBSERVED_DAILY_CEILING)

    // Longer than the staleness window, on purpose.
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
