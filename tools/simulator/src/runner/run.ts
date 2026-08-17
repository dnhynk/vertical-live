import type { StateEngine } from '@vl/server'

import type { ControlName, ScenarioPlan } from '../scenario/index.js'
import { flushEventLoop, type VirtualClock } from './clock.js'
import { postEnvelopeBatch, type InjectResponse, type InjectTarget } from './inject.js'
import type { StubRenderer } from './stub-renderer.js'

/**
 * Plays a scenario against a running server.
 *
 * Two clock modes, and the difference is deliberate (BOARD A-15, spec §7.5):
 *
 * - **virtual** — the injected `VirtualClock` is moved forward in slices and the
 *   writer loop is pumped after each one, so an idle 24 hours costs a loop and
 *   no test waits on real time (§T11 acceptance 1). The instants in `receivedAt`
 *   and in the `/metrics` histograms are then *virtual* durations, which is why
 *   the report labels the clock instead of presenting them as latency.
 * - **system** — the server runs on the real clock and the scenario's offsets are
 *   compressed by `speed` (`0` = post as fast as the server accepts). This is the
 *   mode the latency report uses, because only here is `receivedAt → acked` a
 *   real elapsed time.
 *
 * A control step the runner cannot honour (no renderer attached, an external
 * server) is **reported as skipped**, never silently dropped: a degraded-window
 * scenario that quietly ran without the degraded window would be the worst kind
 * of green result (spec §11 "값을 임의로 채우지 않는다").
 */

export interface RunOptions {
  readonly plan: ScenarioPlan
  readonly target: InjectTarget
  /** Present in virtual mode; absent means the server runs on the system clock. */
  readonly clock?: VirtualClock
  /** In-process engine, pumped after every advance. Absent for an external URL. */
  readonly engine?: StateEngine
  /** Needed for `degrade`/`recover` control steps. */
  readonly renderer?: StubRenderer
  /** Virtual-clock slice, so the world integrates instead of jumping. */
  readonly sliceMs?: number
  /** System-clock playback speed multiplier; `0` removes the waits entirely. */
  readonly speed?: number
  readonly onLog?: (line: string) => void
  /**
   * Called after every writer pass, with the scenario offset reached.
   *
   * A run reports only its own totals, and some of what §T11 has to show is
   * *mid-run*: that the cursor stood still while the broadcast was degraded, for
   * instance (spec §9.2). Sampling here reads the engine's real health rather
   * than reconstructing it from the end state.
   */
  readonly onAdvance?: (scenarioMs: number) => void
}

export interface RunResult {
  readonly scenarioId: string
  readonly clock: 'virtual' | 'system'
  readonly batches: number
  readonly envelopesPosted: number
  readonly accepted: number
  readonly inserted: number
  readonly duplicates: number
  /** Non-2xx responses, as `status:error` tokens. Empty on a clean run. */
  readonly refusals: readonly string[]
  readonly controlsApplied: readonly ControlName[]
  readonly controlsSkipped: readonly ControlName[]
  /** Scenario time crossed, virtual or real depending on the mode. */
  readonly scenarioMs: number
  readonly wallClockMs: number
}

export const DEFAULT_SLICE_MS = 60_000

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { plan, target, clock, engine, renderer } = options
  const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS
  const speed = options.speed ?? 0
  const log = options.onLog ?? (() => {})
  const observe = options.onAdvance ?? (() => {})
  const startedAt = Date.now()

  let cursorMs = 0
  let envelopesPosted = 0
  let accepted = 0
  let inserted = 0
  let duplicates = 0
  const refusals: string[] = []
  const controlsApplied: ControlName[] = []
  const controlsSkipped: ControlName[] = []

  const advanceTo = async (targetMs: number): Promise<void> => {
    if (targetMs <= cursorMs) return
    if (clock === undefined) {
      if (speed > 0) await sleep((targetMs - cursorMs) / speed)
      cursorMs = targetMs
      await flushEventLoop()
      observe(cursorMs)
      return
    }
    while (cursorMs < targetMs) {
      const step = Math.min(sliceMs, targetMs - cursorMs)
      await clock.advance(step)
      cursorMs += step
      engine?.pump()
      await flushEventLoop()
      observe(cursorMs)
    }
  }

  for (const batch of plan.batches) {
    await advanceTo(batch.atMs)

    for (const control of batch.controls) {
      const applied = await applyControl(control, renderer)
      if (applied) {
        controlsApplied.push(control)
        log(`control ${control} applied at ${String(batch.atMs)}ms`)
      } else {
        controlsSkipped.push(control)
        log(`control ${control} SKIPPED at ${String(batch.atMs)}ms (no attached renderer)`)
      }
      // A control changes a degraded condition, which the engine only notices on
      // a pass; without this the very next injection would be judged against the
      // previous condition.
      engine?.pump()
      await flushEventLoop()
      observe(batch.atMs)
    }

    const receivedAt = nowInstant(clock)
    const envelopes = batch.build(receivedAt)
    if (envelopes.length > 0) {
      envelopesPosted += envelopes.length
      for (const response of await postEnvelopeBatch(target, envelopes)) {
        tally(response)
      }
      await flushEventLoop()
      engine?.pump()
      observe(batch.atMs)
    }
  }

  await advanceTo(plan.endsAtMs)
  // One last pass so a deadline that came due in the final slice is committed
  // before the caller reads the state.
  engine?.pump()
  await flushEventLoop()
  observe(plan.endsAtMs)

  function tally(response: InjectResponse): void {
    if (response.status < 200 || response.status >= 300) {
      refusals.push(`${String(response.status)}:${response.error ?? 'unknown'}`)
      return
    }
    accepted += response.accepted
    inserted += response.inserted
    duplicates += response.duplicates
  }

  return {
    scenarioId: plan.scenario.id,
    clock: clock === undefined ? 'system' : 'virtual',
    batches: plan.batches.length,
    envelopesPosted,
    accepted,
    inserted,
    duplicates,
    refusals,
    controlsApplied,
    controlsSkipped,
    scenarioMs: Math.max(cursorMs, plan.endsAtMs),
    wallClockMs: Date.now() - startedAt,
  }
}

/**
 * `degrade` detaches the renderer, which makes `rendererCount` zero — a real
 * degraded reason the engine derives for itself (spec §9.2), not a test hook.
 */
async function applyControl(
  control: ControlName,
  renderer: StubRenderer | undefined,
): Promise<boolean> {
  if (renderer === undefined) return false
  if (control === 'degrade') {
    if (!renderer.connected) return false
    await renderer.disconnect()
    return true
  }
  if (renderer.connected) return false
  await renderer.connect()
  return true
}

function nowInstant(clock: VirtualClock | undefined): string {
  return clock === undefined ? new Date().toISOString() : clock.nowUtcIso()
}

async function sleep(millis: number): Promise<void> {
  if (millis <= 0) return
  await new Promise<void>((resolve) => {
    setTimeout(resolve, millis)
  })
}
