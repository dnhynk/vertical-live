import type { ApiErrorClassification } from './classify.js'

/**
 * Backoff policy T9/T10 use when a YouTube call fails. The policy only computes
 * delays — sleeping, and the decision to keep the run alive, belong to the
 * caller and to T12's supervisor. All numbers come from `config/default.json`
 * (`youtube.quota.backoff`) and are provisional (BOARD A-15).
 */

export interface BackoffPolicy {
  readonly maxAttempts: number
  /** Delay before attempt `attempt` (1 = the first retry). */
  nextDelayMs(attempt: number): number
}

export interface ExponentialBackoffOptions {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly factor: number
  /** Random fraction subtracted from each delay (0…1) to spread retries. */
  readonly jitterRatio: number
  readonly maxAttempts: number
  /** Injected in tests so delays are reproducible (CLAUDE.md §4). */
  readonly random?: () => number
}

export function createExponentialBackoff(options: ExponentialBackoffOptions): BackoffPolicy {
  const { initialDelayMs, maxDelayMs, factor, jitterRatio, maxAttempts } = options
  if (initialDelayMs <= 0 || maxDelayMs < initialDelayMs) {
    throw new Error('initialDelayMs must be > 0 and maxDelayMs >= initialDelayMs')
  }
  if (factor < 1) {
    throw new Error('backoff factor must be >= 1')
  }
  if (jitterRatio < 0 || jitterRatio > 1) {
    throw new Error('jitterRatio must be between 0 and 1')
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer')
  }
  const random = options.random ?? Math.random

  return {
    maxAttempts,
    nextDelayMs(attempt: number): number {
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new Error(`attempt must be a positive integer, got ${attempt}`)
      }
      const raw = Math.min(maxDelayMs, initialDelayMs * factor ** (attempt - 1))
      // Jitter only ever shortens the delay, so `maxDelayMs` stays an upper bound.
      return Math.round(raw * (1 - jitterRatio * random()))
    },
  }
}

export interface RetryDecision {
  readonly retry: boolean
  readonly delayMs: number
  readonly reason: string
}

export interface RetryDecisionInput {
  readonly classification: ApiErrorClassification
  /** Retry number about to be made (1 = first retry). */
  readonly attempt: number
  readonly policy: BackoffPolicy
  /** Milliseconds until the Pacific-midnight quota reset, from `QuotaTracker`. */
  readonly msUntilQuotaReset?: number
}

/**
 * Turns a classification into "wait this long, then retry" or "stop".
 * `quotaExceeded` is not retried on the exponential schedule: nothing changes
 * before the daily reset, so the caller is told to wait for it (T12 reports the
 * `degraded` state meanwhile).
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const { classification, attempt, policy } = input

  if (classification.kind === 'quotaExceeded') {
    return input.msUntilQuotaReset === undefined
      ? { retry: false, delayMs: 0, reason: 'quota exhausted until the daily reset' }
      : {
          retry: true,
          delayMs: input.msUntilQuotaReset,
          reason: 'quota exhausted; retry after the daily reset',
        }
  }
  if (!classification.retryable) {
    return { retry: false, delayMs: 0, reason: `not retryable: ${classification.kind}` }
  }
  if (attempt > policy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: `attempt budget exhausted (${policy.maxAttempts})` }
  }
  const backoffMs = policy.nextDelayMs(attempt)
  // A server-provided Retry-After wins when it asks for a longer wait.
  const delayMs = Math.max(backoffMs, classification.retryAfterMs ?? 0)
  return { retry: true, delayMs, reason: `retry ${attempt}/${policy.maxAttempts}` }
}
