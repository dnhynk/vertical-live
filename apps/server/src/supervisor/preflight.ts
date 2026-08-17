import type { Clock } from '../clock.js'
import {
  PREFLIGHT_CHECKS,
  type PreflightCheck,
  type PreflightCheckResult,
  type PreflightResult,
  type SafeStopKind,
} from './types.js'

/**
 * The `starting` pre-checks of spec §9.2: "자격·비밀정보·상태·API·렌더러·인코더를
 * 사전 점검한다."
 *
 * Every check answers one question and returns *why* it failed. Two failure
 * classes are kept apart on purpose:
 *
 * - retryable — the encoder is not up yet, the renderer has not attached. The
 *   machine stays in `starting` and tries again;
 * - `safeStop` — a revoked grant, a suspended account, a database that failed
 *   its integrity check. Retrying those is exactly what §9.1 forbids, so the
 *   check names the `SafeStopKind` and the supervisor goes to `safe_stopped`.
 *
 * All six run even when an earlier one fails, so one attempt tells the operator
 * everything that is wrong rather than one thing at a time.
 */

export interface PreflightOutcome {
  readonly passed: boolean
  /** Machine-stable token; required when `passed` is false. */
  readonly reason?: string
  /** Set when a retry cannot help (spec §9.1). */
  readonly safeStop?: SafeStopKind
}

export const PREFLIGHT_OK: PreflightOutcome = Object.freeze({ passed: true })

export type PreflightProbe = () => PreflightOutcome | Promise<PreflightOutcome>

/** One probe per check; all six are required so none can be forgotten. */
export type PreflightProbes = Readonly<Record<PreflightCheck, PreflightProbe>>

export async function runPreflight(
  probes: PreflightProbes,
  clock: Clock,
): Promise<PreflightResult> {
  const at = clock.nowUtcIso()
  const checks: PreflightCheckResult[] = []

  for (const check of PREFLIGHT_CHECKS) {
    let outcome: PreflightOutcome
    try {
      outcome = await probes[check]()
    } catch (error) {
      // A probe that throws has not proved anything: it is a failed check with
      // a stable token, never a pass and never an unhandled rejection.
      outcome = { passed: false, reason: `probe_failed:${errorToken(error)}` }
    }
    checks.push({
      check,
      passed: outcome.passed,
      reason: outcome.passed ? null : (outcome.reason ?? 'failed'),
      at,
      safeStop: outcome.passed ? null : (outcome.safeStop ?? null),
    })
  }

  const failed = checks.filter((result) => !result.passed)
  const fatal = failed.find((result) => result.safeStop !== null)

  return {
    passed: failed.length === 0,
    at,
    checks,
    failed: failed.map((result) => result.check),
    safeStop:
      fatal === undefined || fatal.safeStop === null
        ? null
        : {
            kind: fatal.safeStop,
            at,
            reason: `preflight_${fatal.check}:${fatal.reason ?? 'failed'}`,
            detail: { check: fatal.check },
          },
  }
}

function errorToken(error: unknown): string {
  if (error instanceof Error) return error.name
  return 'unknown_error'
}
