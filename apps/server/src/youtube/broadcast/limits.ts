import type { YouTubeApiCallError } from './api.js'

/**
 * The channel-level live limits spec §9.1 enumerates, and how a failure is sorted
 * into them.
 *
 * Official facts (checked 2026-08-17,
 * https://developers.google.com/youtube/v3/live/docs/errors):
 *
 * - `limitExceeded` / `userBroadcastsExceedLimit` — "The user has created too many
 *   live or scheduled broadcasts and must stop or delete some" (insert)
 * - `rateLimitExceeded` / `concurrentBroadcastsExceedLimit` — "The channel already
 *   has the maximum number of concurrent live broadcasts" (transition)
 * - `rateLimitExceeded` / `sharedIngestionBroadcastsExceedLimit` — maximum
 *   broadcasts sharing one ingestion source exceeded. This one matters here
 *   because a reusable stream is exactly a shared ingestion source.
 *
 * What is **not** published: the daily creation limit. YouTube Help states only
 * "If you've reached your daily limit for creating live streams, you can try again
 * in 24 hours" (https://support.google.com/youtube/answer/2853834), with no number,
 * and the API error reference lists no reason string for it. So the product cannot
 * count towards a threshold of its own invention (spec §9.1 names it as a limit
 * "공개 숫자가 없는"), and it cannot match a documented reason either. It is
 * therefore detected as "limit-shaped but not one of the three named reasons".
 *
 * That inference is safe because **all four kinds take the same action**: recover
 * an existing broadcast first, and if that is impossible ask for `safe_stopped`
 * and alert (spec §9.1). A misclassification changes the label on an alert, never
 * what the server does.
 */

export type BroadcastLimitKind =
  | 'user_broadcasts'
  | 'concurrent_broadcasts'
  | 'shared_ingestion'
  /** Limit-shaped and not one of the named reasons; see the module comment. */
  | 'daily_creation'

const NAMED_LIMIT_REASONS: Readonly<Record<string, BroadcastLimitKind>> = Object.freeze({
  userBroadcastsExceedLimit: 'user_broadcasts',
  concurrentBroadcastsExceedLimit: 'concurrent_broadcasts',
  sharedIngestionBroadcastsExceedLimit: 'shared_ingestion',
})

/**
 * `…ExceedLimit` and `…LimitExceeded` are both used by Google's reason strings, so
 * either suffix counts as limit-shaped — but only after the rate-limit and quota
 * kinds have been excluded, because `rateLimitExceeded` and `dailyLimitExceeded`
 * also end that way and mean "wait", not "the channel is full".
 */
const LIMIT_SHAPED_REASON = /(ExceedLimit|LimitExceeded)$/

/** The limit kind a failure represents, or `null` when it is not a limit. */
export function classifyBroadcastLimit(error: YouTubeApiCallError): BroadcastLimitKind | null {
  const reason = error.reason
  if (reason !== undefined) {
    const named = NAMED_LIMIT_REASONS[reason]
    if (named !== undefined) {
      return named
    }
  }
  const kind = error.classification.kind
  if (kind === 'rateLimitExceeded' || kind === 'quotaExceeded') {
    return null
  }
  if (kind === 'broadcastLimit') {
    return 'daily_creation'
  }
  if (reason !== undefined && LIMIT_SHAPED_REASON.test(reason)) {
    return 'daily_creation'
  }
  return null
}

/**
 * YouTube `lifeCycleStatus` values a broadcast can be adopted from — it is either
 * already carrying the stream or can still be driven to `live`. `complete` and
 * `revoked` are excluded: neither can be brought back (spec §9.1 recovery).
 */
export const ADOPTABLE_LIFE_CYCLE_STATUSES: readonly string[] = Object.freeze([
  'live',
  'liveStarting',
  'testing',
  'testStarting',
  'ready',
  'created',
])

/** Statuses that mean the broadcast is already carrying video. */
export const LIVE_LIFE_CYCLE_STATUSES: readonly string[] = Object.freeze(['live', 'liveStarting'])

export function isAdoptableLifeCycleStatus(status: string | null): boolean {
  return status !== null && ADOPTABLE_LIFE_CYCLE_STATUSES.includes(status)
}

export function isLiveLifeCycleStatus(status: string | null): boolean {
  return status !== null && LIVE_LIFE_CYCLE_STATUSES.includes(status)
}
