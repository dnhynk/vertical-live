import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import { FakeClock } from '../../testing/fake-clock.js'
import {
  METHOD_SCOPES,
  PLANNED_METHODS,
  REQUIRED_SCOPES,
  checkScopeCoverage,
  sufficientSingleScopes,
  unverifiedScopeMethods,
} from '../scopes.js'
import { createExponentialBackoff, decideRetry } from './backoff.js'
import { GRPC_CODES, classifyYouTubeApiError } from './classify.js'
import { loadQuotaConfig } from './config.js'
import { QUOTA_COSTS, QUOTA_DAILY_DEFAULT_UNITS, provisionalQuotaMethods } from './costs.js'
import { QuotaTracker, nextMidnightMs, quotaDayOf } from './tracker.js'

/** Acceptance criterion 3 (`docs/tasks/TASK_SPECS.md` §T3). */
describe('quota cost table', () => {
  it('covers every method the product plans to call, with evidence', () => {
    const required = [
      'liveChatMessages.list',
      'liveChatMessages.streamList',
      'liveBroadcasts.insert',
      'liveBroadcasts.list',
      'liveBroadcasts.bind',
      'liveBroadcasts.transition',
      'liveStreams.insert',
      'liveStreams.list',
    ] as const

    for (const method of required) {
      expect(PLANNED_METHODS).toContain(method)
      const entry = QUOTA_COSTS[method]
      expect(entry.units).toBeGreaterThan(0)
      expect(entry.evidenceUrl).toMatch(/^https:\/\/developers\.google\.com\//)
      expect(entry.checkedOn).toBe('2026-08-17')
      expect(entry.basis.length).toBeGreaterThan(20)
    }
    // Nothing in the table is missing an entry.
    for (const method of PLANNED_METHODS) {
      expect(QUOTA_COSTS[method]).toBeDefined()
    }
  })

  it('marks the derived live-streaming costs as provisional', () => {
    // Google publishes no per-method figure for these; the table must say so
    // instead of presenting a guess as documented.
    expect(provisionalQuotaMethods()).toContain('liveBroadcasts.insert')
    expect(QUOTA_COSTS['videos.list'].documented).toBe(true)
  })

  it('uses the documented default daily allocation', () => {
    expect(QUOTA_DAILY_DEFAULT_UNITS).toBe(10_000)
  })
})

describe('minimal scope set', () => {
  it('is one scope and covers every verified method', () => {
    expect(REQUIRED_SCOPES).toHaveLength(1)
    const coverage = checkScopeCoverage(REQUIRED_SCOPES)
    expect(coverage.sufficient).toBe(true)
    expect(coverage.uncoveredMethods).toEqual([])
    expect(coverage.extraneousScopes).toEqual([])
  })

  it('records that two single scopes are sufficient, not one', () => {
    // Review round 1, B3: the claim that force-ssl was the *only* sufficient
    // single scope was false on the method evidence. The tie is recorded here
    // so the choice stays a documented judgment (see scopes.ts) rather than a
    // claim the evidence does not support.
    expect(sufficientSingleScopes()).toEqual([
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.force-ssl',
    ])
    expect(sufficientSingleScopes()).toContain(REQUIRED_SCOPES[0])
  })

  it('reports the methods whose scopes no official source states', () => {
    // These are unverifiable, not unchecked: recorded so no acceptance claim
    // covers them (review round 1, B3).
    expect(unverifiedScopeMethods()).toEqual(['liveChatMessages.streamList', 'videos.list'])
    expect(METHOD_SCOPES['liveChatMessages.streamList'].note).toContain('UNVERIFIABLE')
    expect(METHOD_SCOPES['liveChatMessages.streamList'].evidenceUrl).toBe(
      'https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList',
    )
  })

  it('rejects a read-only grant, which cannot create or transition a broadcast', () => {
    const coverage = checkScopeCoverage(['https://www.googleapis.com/auth/youtube.readonly'])
    expect(coverage.sufficient).toBe(false)
    expect(coverage.uncoveredMethods).toContain('liveBroadcasts.insert')
  })

  it('reports a broader grant as extraneous rather than accepting it silently', () => {
    const coverage = checkScopeCoverage([
      ...REQUIRED_SCOPES,
      'https://www.googleapis.com/auth/youtube',
    ])
    expect(coverage.sufficient).toBe(true)
    expect(coverage.extraneousScopes).toEqual([])
    // `youtube` is accepted by the same methods, so it is not extraneous —
    // but a scope no planned method accepts is.
    const withUpload = checkScopeCoverage([
      ...REQUIRED_SCOPES,
      'https://www.googleapis.com/auth/youtube.upload',
    ])
    expect(withUpload.extraneousScopes).toEqual(['https://www.googleapis.com/auth/youtube.upload'])
  })

  it('keeps unverified methods out of the proof', () => {
    expect(METHOD_SCOPES['liveChatMessages.streamList'].verified).toBe(false)
    expect(METHOD_SCOPES['liveChatMessages.streamList'].note).toBeTruthy()
  })
})

describe('QuotaTracker', () => {
  // 2026-08-17T12:00:00Z is 05:00 in Pacific Daylight Time.
  const noonUtc = Date.UTC(2026, 7, 17, 12)

  function tracker(options: { reserveUnits?: number } = {}): {
    tracker: QuotaTracker
    clock: FakeClock
  } {
    const clock = new FakeClock({ epochMs: noonUtc })
    return {
      clock,
      tracker: new QuotaTracker({
        clock,
        dailyUnits: 10_000,
        ...(options.reserveUnits === undefined ? {} : { reserveUnits: options.reserveUnits }),
      }),
    }
  }

  it('books the documented cost per method', () => {
    const { tracker: t } = tracker()
    t.record('liveChatMessages.list', 10)
    const usage = t.record('liveBroadcasts.insert')

    expect(usage.spentUnits).toBe(60)
    expect(usage.byMethod['liveChatMessages.list']).toBe(10)
    expect(usage.byMethod['liveBroadcasts.insert']).toBe(50)
    expect(usage.remainingUnits).toBe(9_940)
    expect(usage.quotaDay).toBe('2026-08-17')
  })

  it('protects the reserve but still counts past it', () => {
    const { tracker: t } = tracker({ reserveUnits: 500 })
    t.record('liveBroadcasts.insert', 190) // 9,500 units: reserve reached

    expect(t.canSpend('liveBroadcasts.insert')).toBe(false)
    expect(t.canSpend('liveChatMessages.list')).toBe(false)
    expect(t.isExhausted('liveBroadcasts.insert')).toBe(false)

    t.record('liveBroadcasts.insert', 10) // 10,000 units: budget gone
    expect(t.isExhausted('liveChatMessages.list')).toBe(true)
  })

  it('rolls over at Pacific midnight, not UTC midnight', async () => {
    const { tracker: t, clock } = tracker()
    t.record('liveBroadcasts.insert')
    expect(t.snapshot().spentUnits).toBe(50)

    // 12:00Z + 11h = 23:00Z, still 16:00 PT on the same quota day.
    await clock.advance(11 * 3_600_000)
    expect(t.snapshot()).toMatchObject({ quotaDay: '2026-08-17', spentUnits: 50 })

    // +8h more = 07:00Z next day = 00:00 PT: the counter resets.
    await clock.advance(8 * 3_600_000)
    expect(t.snapshot()).toMatchObject({ quotaDay: '2026-08-18', spentUnits: 0 })
  })

  it('reports the next reset as an absolute UTC instant', () => {
    const { tracker: t } = tracker()
    expect(t.nextResetAt()).toBe('2026-08-18T07:00:00.000Z')
    expect(t.msUntilReset()).toBe(19 * 3_600_000)
  })

  it('restores a snapshot from the same quota day and drops a stale one', () => {
    const { tracker: t } = tracker()
    t.restore({
      quotaDay: '2026-08-17',
      spentUnits: 4_000,
      dailyUnits: 10_000,
      reserveUnits: 0,
      remainingUnits: 6_000,
      byMethod: { 'liveChatMessages.list': 4_000 },
    })
    expect(t.snapshot().spentUnits).toBe(4_000)

    t.restore({
      quotaDay: '2026-08-16',
      spentUnits: 9_000,
      dailyUnits: 10_000,
      reserveUnits: 0,
      remainingUnits: 1_000,
      byMethod: {},
    })
    expect(t.snapshot().spentUnits).toBe(0)
  })

  it('computes quota days and resets across the DST boundary', () => {
    // 2026-11-01 02:00 PDT → 01:00 PST (fall back). The reset must stay at
    // local midnight, which is 07:00Z before the change and 08:00Z after.
    expect(quotaDayOf(Date.UTC(2026, 10, 1, 6))).toBe('2026-10-31')
    expect(new Date(nextMidnightMs(Date.UTC(2026, 10, 1, 6))).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    )
    // 2026-11-02T06:00Z is 22:00 on Nov 1 in PST (UTC-8): the next local
    // midnight is Nov 2, which is 08:00Z rather than the pre-change 07:00Z.
    expect(new Date(nextMidnightMs(Date.UTC(2026, 10, 2, 6))).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    )
  })
})

/**
 * The counter used to live only in process memory. On 2026-08-23 the host
 * restarted several times, each restart set it back to zero, and the day's
 * allowance went with no warning logged while Google's account-wide counter
 * kept climbing (T44).
 */
describe('QuotaTracker persistence', () => {
  const noonUtc = Date.UTC(2026, 7, 17, 12)
  let temp: TempStore

  beforeEach(() => {
    temp = createTempStore({ clock: new FakeClock({ epochMs: noonUtc }) })
  })
  afterEach(() => {
    temp.dispose()
  })

  function tracker(store = temp.store): QuotaTracker {
    return new QuotaTracker({
      clock: new FakeClock({ epochMs: noonUtc }),
      dailyUnits: 10_000,
      reserveUnits: 500,
      store,
    })
  }

  it('restores the day it already spent when the process restarts', () => {
    const before = tracker()
    before.record('liveBroadcasts.insert') // 50
    before.record('liveStreams.list', 30) // 30
    expect(before.snapshot().spentUnits).toBe(80)

    const after = tracker(temp.reopen())

    expect(after.snapshot().spentUnits).toBe(80)
    expect(after.snapshot().byMethod['liveBroadcasts.insert']).toBe(50)
    expect(after.snapshot().byMethod['liveStreams.list']).toBe(30)
  })

  it('still refuses a call the restored day cannot afford', () => {
    const before = tracker()
    before.record('liveStreams.list', 9_600)
    expect(before.canSpend('liveStreams.list')).toBe(false)

    // The point of the fix: the restart used to answer `true` here.
    expect(tracker(temp.reopen()).canSpend('liveStreams.list')).toBe(false)
  })

  it('does not carry one quota day into the next', () => {
    tracker().record('liveStreams.list', 100)
    const nextDay = new QuotaTracker({
      clock: new FakeClock({ epochMs: noonUtc + 24 * 60 * 60 * 1000 }),
      dailyUnits: 10_000,
      store: temp.reopen(),
    })

    expect(nextDay.snapshot().spentUnits).toBe(0)
  })
})

describe('classifyYouTubeApiError', () => {
  const body = (reason: string, code = 403): unknown => ({
    error: { code, message: 'synthetic', errors: [{ reason, domain: 'youtube.quota' }] },
  })

  it('separates quota exhaustion from rate limiting', () => {
    expect(classifyYouTubeApiError({ httpStatus: 403, body: body('quotaExceeded') })).toMatchObject(
      {
        kind: 'quotaExceeded',
        action: 'degraded',
        retryable: false,
      },
    )
    expect(
      classifyYouTubeApiError({ httpStatus: 403, body: body('rateLimitExceeded') }),
    ).toMatchObject({ kind: 'rateLimitExceeded', action: 'retry', retryable: true })
    expect(classifyYouTubeApiError({ httpStatus: 429 })).toMatchObject({
      kind: 'rateLimitExceeded',
      retryable: true,
    })
  })

  it('treats permission problems as safe_stopped and auth problems as refreshable', () => {
    expect(
      classifyYouTubeApiError({ httpStatus: 403, body: body('insufficientLivePermissions') }),
    ).toMatchObject({ kind: 'forbidden', action: 'safe_stopped', retryable: false })
    expect(classifyYouTubeApiError({ httpStatus: 401 })).toMatchObject({
      kind: 'unauthorized',
      action: 'retry',
      refreshAuth: true,
    })
  })

  it('maps broadcast limits and chat lifecycle to degraded', () => {
    expect(
      classifyYouTubeApiError({ httpStatus: 403, body: body('userBroadcastsExceedLimit') }),
    ).toMatchObject({ kind: 'broadcastLimit', action: 'degraded' })
    expect(classifyYouTubeApiError({ httpStatus: 403, body: body('liveChatEnded') })).toMatchObject(
      { kind: 'failedPrecondition', action: 'degraded' },
    )
  })

  it('maps gRPC streamList codes', () => {
    expect(classifyYouTubeApiError({ grpcCode: GRPC_CODES.RESOURCE_EXHAUSTED })).toMatchObject({
      kind: 'rateLimitExceeded',
      retryable: true,
    })
    expect(classifyYouTubeApiError({ grpcCode: GRPC_CODES.FAILED_PRECONDITION })).toMatchObject({
      kind: 'failedPrecondition',
      action: 'degraded',
    })
    expect(classifyYouTubeApiError({ grpcCode: GRPC_CODES.UNAVAILABLE })).toMatchObject({
      kind: 'serverError',
      retryable: true,
    })
  })

  it('handles transport failures and Retry-After', () => {
    expect(classifyYouTubeApiError({ errorCode: 'ECONNRESET' })).toMatchObject({
      kind: 'network',
      action: 'retry',
    })
    expect(classifyYouTubeApiError({ httpStatus: 429, retryAfterHeader: '30' }).retryAfterMs).toBe(
      30_000,
    )
    expect(
      classifyYouTubeApiError({
        httpStatus: 429,
        retryAfterHeader: 'Mon, 17 Aug 2026 12:00:30 GMT',
        nowMs: Date.UTC(2026, 7, 17, 12),
      }).retryAfterMs,
    ).toBe(30_000)
  })

  it('accepts a raw JSON body string', () => {
    expect(
      classifyYouTubeApiError({ httpStatus: 403, body: JSON.stringify(body('quotaExceeded')) }),
    ).toMatchObject({ kind: 'quotaExceeded', reason: 'quotaExceeded' })
  })
})

describe('backoff', () => {
  const policy = createExponentialBackoff({
    initialDelayMs: 1000,
    maxDelayMs: 300_000,
    factor: 2,
    jitterRatio: 0.2,
    maxAttempts: 8,
    random: () => 0.5, // seeded: every delay loses exactly half the jitter
  })

  it('grows exponentially and clamps at maxDelayMs', () => {
    expect(policy.nextDelayMs(1)).toBe(900)
    expect(policy.nextDelayMs(2)).toBe(1_800)
    expect(policy.nextDelayMs(3)).toBe(3_600)
    expect(policy.nextDelayMs(9)).toBe(230_400)
    expect(policy.nextDelayMs(20)).toBe(270_000)
  })

  it('rejects invalid options and attempts', () => {
    expect(() =>
      createExponentialBackoff({
        initialDelayMs: 0,
        maxDelayMs: 10,
        factor: 2,
        jitterRatio: 0,
        maxAttempts: 3,
      }),
    ).toThrow()
    expect(() => policy.nextDelayMs(0)).toThrow()
  })

  it('waits for the quota reset instead of retrying a spent quota', () => {
    const classification = classifyYouTubeApiError({
      httpStatus: 403,
      body: { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } },
    })
    expect(decideRetry({ classification, attempt: 1, policy })).toMatchObject({ retry: false })
    expect(
      decideRetry({ classification, attempt: 1, policy, msUntilQuotaReset: 19 * 3_600_000 }),
    ).toMatchObject({ retry: true, delayMs: 19 * 3_600_000 })
  })

  it('stops at the attempt budget and honours Retry-After', () => {
    const classification = classifyYouTubeApiError({ httpStatus: 429, retryAfterHeader: '120' })
    expect(decideRetry({ classification, attempt: 1, policy })).toMatchObject({
      retry: true,
      delayMs: 120_000,
    })
    expect(decideRetry({ classification, attempt: 9, policy })).toMatchObject({ retry: false })

    const forbidden = classifyYouTubeApiError({ httpStatus: 403 })
    expect(decideRetry({ classification: forbidden, attempt: 1, policy })).toMatchObject({
      retry: false,
    })
  })
})

describe('quota config', () => {
  it('loads the repository config', () => {
    const config = loadQuotaConfig()
    expect(config.dailyUnits).toBe(10_000)
    expect(config.resetTimeZone).toBe('America/Los_Angeles')
    expect(config.provisional).toContain('backoff')
    expect(config.backoff.factor).toBeGreaterThanOrEqual(1)
  })
})
