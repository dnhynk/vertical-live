import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { Effect, WorldSnapshot } from '@vl/contract'

import type { RendererConnection } from './read-model/connection'
import type { LogEntry, RendererLog } from './read-model/log'
import type { ReadModel } from './read-model/store'

/** Subscribes to the read model and reports each commit back to it. */
export function useReadModel(model: ReadModel): {
  snapshot: WorldSnapshot | null
  activeEffects: readonly Effect[]
  /** Commit the slot's action was applied at (T20c); `null` when unknown. */
  actionRevision: number | null
} {
  const subscribe = useCallback((onChange: () => void) => model.subscribe(onChange), [model])
  useSyncExternalStore(
    subscribe,
    () => model.version,
    () => model.version,
  )

  // Runs after every commit, before the browser paints. The frame loop then
  // turns "committed" into "drawn" and releases the ACK (spec §7.3(7)).
  useLayoutEffect(() => {
    model.markCommitted()
  })

  return {
    snapshot: model.snapshot,
    activeEffects: model.activeEffects,
    actionRevision: model.actionRevision,
  }
}

export function useConnectionVersion(connection: RendererConnection): number {
  const subscribe = useCallback(
    (onChange: () => void) => connection.subscribe(onChange),
    [connection],
  )
  return useSyncExternalStore(
    subscribe,
    () => connection.version,
    () => connection.version,
  )
}

export function useLogEntries(log: RendererLog): readonly LogEntry[] {
  const subscribe = useCallback((onChange: () => void) => log.subscribe(onChange), [log])
  useSyncExternalStore(
    subscribe,
    () => log.version,
    () => log.version,
  )
  return log.entries()
}

/** Re-renders on an interval so live counters (frames, FPS) stay readable. */
export function useTick(intervalMs: number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const handle = setInterval(() => {
      setTick((previous) => previous + 1)
    }, intervalMs)
    return () => {
      clearInterval(handle)
    }
  }, [intervalMs])
  return tick
}
