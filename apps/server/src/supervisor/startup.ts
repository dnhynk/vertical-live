import type { Clock } from '../clock.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'

/**
 * The start-up order of spec §7.3(3) and §9.1, as data.
 *
 * TASK_SPECS §T12 lists the order the preceding tasks left for T12 to wire and
 * requires that it be "코드와 테스트로 고정". So the order is a frozen array and
 * the runner iterates *it*, not the object a caller passes in: a caller supplies
 * a step per name and cannot change when its step runs.
 *
 * Why this order and not another:
 *
 * 1. `db` — the store is the authority (spec §10.2); migrations run before
 *    anything reads state.
 * 2. `engine` — recovery drains the inbox and applies the deadline policies
 *    before anything new is accepted (§7.3(3)); T9 waits on `engine.ready`.
 * 3. `retention` — T13's sweeper and the revocation sink are connected before
 *    the first API call can collect anything that would need deleting (§12.4).
 * 4. `broadcast` — `ensureBound()` persists resource ids *before* the calls that
 *    create them, and reconciles anything left in flight (§9.1).
 * 5. `streamService` — the vault's runtime injections into OBS (BOARD A-16):
 *    the renderer Browser Source URL with its token, then the stream key. The
 *    operator types neither into the OBS UI (T17).
 * 6. `startStream` — the encoder starts pushing only after it has a key and a
 *    bound ingest.
 * 7. `goLive` — the one step TASK_SPECS §T12 does not name, added because the
 *    two steps around it need it: a broadcast only has a `liveChatId` once it is
 *    live, and `enableAutoStart` can be refused (`invalidAutoStart`, spec §4), in
 *    which case somebody has to run the transition. `BroadcastLifecycle.goLive()`
 *    waits for auto-start first and falls back to the transition, so this step is
 *    a no-op on the happy path rather than a second way of starting a broadcast.
 * 8. `chatSource` — the `liveChatId` comes from the open attempt in
 *    `broadcast_resources`, so it cannot start before step 4.
 * 9. `publish` — last, and only after the attempt marker has been removed from
 *    the public description (BOARD A-18). Spec §9.1 keeps the first public
 *    go-live with the operator, so this step does nothing while
 *    `youtube.broadcast.privacyStatus` is `private`.
 *
 * A step that fails stops the sequence: everything after it depends on it, and
 * a half-started broadcast that kept going would be exactly the "무책임 운영"
 * §2.9 rules out.
 */

export const STARTUP_STEP_ORDER = [
  'db',
  'engine',
  'retention',
  'broadcast',
  'streamService',
  'startStream',
  'goLive',
  'chatSource',
  'publish',
] as const

export type StartupStep = (typeof STARTUP_STEP_ORDER)[number]

/**
 * What a step is told while it runs. A step that waits on I/O — every step from
 * `broadcast` on does — must check `cancelled()` before each outward effect:
 * the run can stop while it is waiting, and after that nothing may start a
 * broadcast, an encoder or a listener (spec §9.1, §9.2; review round 3).
 */
export interface StartupStepContext {
  cancelled(): boolean
}

export type StartupStepAction = (context: StartupStepContext) => Promise<void> | void

export type StartupSteps = Readonly<Record<StartupStep, StartupStepAction>>

export interface StartupStepResult {
  readonly step: StartupStep
  /**
   * `cancelled` is the step that was in flight when the run stopped, plus every
   * step after it: their results are discarded and they are not run.
   */
  readonly status: 'completed' | 'failed' | 'skipped' | 'cancelled'
  readonly at: string
  readonly durationMs: number | null
  /** Machine-stable failure text; `null` unless the step failed. */
  readonly error: string | null
}

export interface StartupResult {
  readonly completed: boolean
  readonly steps: readonly StartupStepResult[]
  readonly failedStep: StartupStep | null
  readonly error: string | null
  /** True when the sequence stopped because the run did (not a step failure). */
  readonly aborted: boolean
}

export interface RunStartupOptions {
  readonly steps: StartupSteps
  readonly clock: Clock
  readonly logger?: Logger
  readonly onStep?: (result: StartupStepResult) => void
  /**
   * Checked before every step *and* again after each awaited step returns.
   * `false` abandons the sequence: the awaited step's result is discarded and
   * nothing later runs. Absent means "nothing can stop this run", which only the
   * unit tests of ordering want.
   */
  readonly canContinue?: () => boolean
}

export async function runStartupSequence(options: RunStartupOptions): Promise<StartupResult> {
  const logger = options.logger ?? silentLogger
  const results: StartupStepResult[] = []
  const canContinue = options.canContinue ?? (() => true)
  const context: StartupStepContext = { cancelled: () => !canContinue() }
  let failedStep: StartupStep | null = null
  let error: string | null = null
  let aborted = false

  const record = (
    step: StartupStep,
    status: StartupStepResult['status'],
    durationMs: number | null,
    stepError: string | null,
  ): void => {
    const result: StartupStepResult = {
      step,
      status,
      at: options.clock.nowUtcIso(),
      durationMs,
      error: stepError,
    }
    results.push(result)
    options.onStep?.(result)
  }

  for (const step of STARTUP_STEP_ORDER) {
    if (aborted) {
      record(step, 'cancelled', null, null)
      continue
    }
    if (failedStep !== null) {
      record(step, 'skipped', null, null)
      continue
    }
    // Before: the run may have stopped while the previous step was awaiting.
    if (!canContinue()) {
      aborted = true
      logger.warn('startup cancelled: the run has stopped', { step })
      record(step, 'cancelled', null, null)
      continue
    }

    const startedAt = options.clock.monotonicMs()
    try {
      await options.steps[step](context)
      // After: the step waited on I/O, and the run may have stopped meanwhile.
      // Its result is discarded rather than carried into the next step — the
      // encoder and the broadcast must not be touched after a safety stop
      // (spec §9.1, §9.2; review round 3).
      if (!canContinue()) {
        aborted = true
        logger.warn('startup cancelled while a step was in flight', { step })
        record(step, 'cancelled', options.clock.monotonicMs() - startedAt, null)
        continue
      }
      const durationMs = options.clock.monotonicMs() - startedAt
      record(step, 'completed', durationMs, null)
      logger.info('startup step completed', { step, durationMs })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
      if (!canContinue()) {
        // A step that threw *because* the run stopped is a cancellation, not a
        // start-up failure: it must not spend a retry or raise a failure alert.
        aborted = true
        logger.warn('startup cancelled while a step was in flight', { step, error })
        record(step, 'cancelled', options.clock.monotonicMs() - startedAt, error)
        error = null
        continue
      }
      failedStep = step
      record(step, 'failed', options.clock.monotonicMs() - startedAt, error)
      logger.error('startup step failed', { step, error })
    }
  }

  return {
    completed: failedStep === null && !aborted,
    steps: results,
    failedStep,
    error,
    aborted,
  }
}
