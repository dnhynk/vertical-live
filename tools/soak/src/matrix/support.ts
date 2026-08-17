import { VirtualClock } from '@vl/simulator'

import { SoakSystem, type SoakSystemOptions } from '../system.js'

/**
 * Shared scaffolding for the fault matrix drills.
 *
 * Every drill runs on a virtual clock: a row that has to spend a restart budget
 * or wait out a `preflightRetryIntervalMs` must not spend real seconds doing it,
 * and a virtual clock also makes the whole matrix reproducible (spec §10.2).
 */

/** Evaluation cadence. Under `supervisor.coordinatorHeartbeatTimeoutMs` (15 s). */
export const SLICE_MS = 5_000

/**
 * Restart backoff, flattened. The delays themselves are T12's and are tested
 * there; a matrix drill is about the *outcome* of spending the budget, and the
 * production delays would push a virtual run past other families' freshness
 * windows before the budget was gone.
 */
export const RESTART_DELAY_MS = 500

export interface DrillSystem {
  readonly system: SoakSystem
  readonly clock: VirtualClock
}

export async function startDrill(
  options: Partial<Omit<SoakSystemOptions, 'clock' | 'virtualClock'>> = {},
): Promise<DrillSystem> {
  const clock = new VirtualClock()
  const system = await SoakSystem.start({
    clock,
    virtualClock: clock,
    restartDelayMs: RESTART_DELAY_MS,
    ...options,
  })
  return { system, clock }
}

/** Start-up through to `live`, which every drill begins from. */
export async function startLive(
  options: Partial<Omit<SoakSystemOptions, 'clock' | 'virtualClock'>> = {},
): Promise<DrillSystem> {
  const drill = await startDrill(options)
  await drill.system.bringUp(SLICE_MS)
  return drill
}

/** Runs slices until `predicate` holds, or gives up and says what it saw. */
export async function tickUntil(
  system: SoakSystem,
  predicate: (system: SoakSystem) => boolean,
  what: string,
  maxTicks = 60,
): Promise<number> {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (predicate(system)) return tick
    await system.tick(SLICE_MS)
  }
  if (predicate(system)) return maxTicks
  const health = system.supervisor.health()
  throw new Error(
    `${what} did not happen in ${String(maxTicks)} slices: state=${health.state} reason=${health.lastTransitionReason}` +
      ` degraded=[${(system.supervisor.aggregate?.degradedFamilies ?? []).join(',')}]`,
  )
}

export async function tick(system: SoakSystem, slices: number): Promise<void> {
  for (let index = 0; index < slices; index += 1) await system.tick(SLICE_MS)
}
