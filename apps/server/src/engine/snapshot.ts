import {
  CONTRACT_VERSION,
  WorldSnapshotSchema,
  type AggregateWindow,
  type BroadcastLifecycle,
  type InputMode,
  type WorldSnapshot,
} from '@vl/contract'

import { projectWorldView } from '../world/project.js'
import type { WorldState } from '../world/types.js'

/**
 * The read model the renderer receives (spec §5.2, §7.3(6), §10.2).
 *
 * `projectWorldView` returns the world's own share — creature, environment,
 * mission, the four display slots. Everything below it is the engine's: the
 * revision the transition was committed at, the cursor it covers, the input mode
 * and the CTA switch of spec §9.2. Keeping the split here means the reducer
 * never has to know a revision exists.
 */

export interface SnapshotContext {
  readonly revision: number
  readonly processedIngestSeq: number
  readonly inputMode: InputMode
  /** False disables the on-screen CTA while input or renderer ACK is unhealthy. */
  readonly interactionEnabled: boolean
  readonly broadcastLifecycle: BroadcastLifecycle
  /** The open tally window, when one should be on screen (spec §6.4). */
  readonly aggregateWindow?: AggregateWindow
}

export function buildSnapshot(state: WorldState, context: SnapshotContext): WorldSnapshot {
  const view = projectWorldView(state)
  return WorldSnapshotSchema.parse({
    schemaVersion: CONTRACT_VERSION,
    stateRevision: context.revision,
    processedIngestSeq: context.processedIngestSeq,
    worldTimeUtc: view.worldTimeUtc,
    inputMode: context.inputMode,
    interactionEnabled: context.interactionEnabled,
    broadcastLifecycle: context.broadcastLifecycle,
    creature: view.creature,
    mission: view.mission,
    environment: view.environment,
    nextTransitionAt: view.nextTransitionAt,
    display: {
      ...view.display,
      ...(context.aggregateWindow === undefined
        ? {}
        : { aggregateWindow: context.aggregateWindow }),
    },
  })
}
