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
 * 5. `streamService` — the stream key goes from the vault into OBS at runtime
 *    (BOARD A-16); the operator never types it into the OBS UI.
 * 6. `startStream` — the encoder starts pushing only after it has a key and a
 *    bound ingest.
 * 7. `chatSource` — the `liveChatId` comes from the open attempt in
 *    `broadcast_resources`, so it cannot start before step 4.
 * 8. `publish` — last, and only after the attempt marker has been removed from
 *    the public description (BOARD A-18).
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
  'chatSource',
  'publish',
] as const

export type StartupStep = (typeof STARTUP_STEP_ORDER)[number]

export type StartupStepAction = () => Promise<void> | void

export type StartupSteps = Readonly<Record<StartupStep, StartupStepAction>>

export interface StartupStepResult {
  readonly step: StartupStep
  readonly status: 'completed' | 'failed' | 'skipped'
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
}

export interface RunStartupOptions {
  readonly steps: StartupSteps
  readonly clock: Clock
  readonly logger?: Logger
  readonly onStep?: (result: StartupStepResult) => void
}

export async function runStartupSequence(options: RunStartupOptions): Promise<StartupResult> {
  const logger = options.logger ?? silentLogger
  const results: StartupStepResult[] = []
  let failedStep: StartupStep | null = null
  let error: string | null = null

  for (const step of STARTUP_STEP_ORDER) {
    if (failedStep !== null) {
      const skipped: StartupStepResult = {
        step,
        status: 'skipped',
        at: options.clock.nowUtcIso(),
        durationMs: null,
        error: null,
      }
      results.push(skipped)
      options.onStep?.(skipped)
      continue
    }

    const startedAt = options.clock.monotonicMs()
    let result: StartupStepResult
    try {
      await options.steps[step]()
      result = {
        step,
        status: 'completed',
        at: options.clock.nowUtcIso(),
        durationMs: options.clock.monotonicMs() - startedAt,
        error: null,
      }
      logger.info('startup step completed', { step, durationMs: result.durationMs })
    } catch (caught) {
      failedStep = step
      error = caught instanceof Error ? caught.message : String(caught)
      result = {
        step,
        status: 'failed',
        at: options.clock.nowUtcIso(),
        durationMs: options.clock.monotonicMs() - startedAt,
        error,
      }
      logger.error('startup step failed', { step, error })
    }
    results.push(result)
    options.onStep?.(result)
  }

  return { completed: failedStep === null, steps: results, failedStep, error }
}
