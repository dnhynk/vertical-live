/**
 * `@vl/server` state engine (TASK_SPECS §T8): the single writer.
 *
 * `StateEngine` owns every state change; `RendererHub` puts committed state on
 * the wire; `EngineMetrics` measures the four legs of spec §7.3(8). Nothing else
 * in the server writes to `world_snapshot`, the effect outbox or the paid ledger.
 */
export {
  StateEngine,
  giftBaseKey,
  nullPublisher,
  toCanonicalEvent,
  type EngineHealth,
  type EnginePublisher,
  type InputHealth,
  type StateEngineOptions,
} from './engine.js'
export {
  EngineConfigError,
  loadEngineConfig,
  type EngineConfig,
  type EngineDegradedConfig,
  type EngineEffectConfig,
  type EngineRuntimeConfig,
  type LoadEngineConfigOptions,
  type SimulatorConfig,
} from './config.js'
export { assembleEffect, assembleEffects, type EffectAssemblyContext } from './effects.js'
export {
  deadlineRowIdOf,
  deadlineTableDiff,
  toDeadlineRecord,
  type DeadlineDiffInput,
  type DeadlineOutcome,
} from './deadlines.js'
export { deadlineRowIdFor, effectIdFor } from './ids.js'
export {
  EngineMetrics,
  LatencyHistogram,
  type EngineMetricsSnapshot,
  type LatencySummary,
} from './metrics.js'
export {
  RENDERER_WS_PATH,
  RendererHub,
  type RendererEvents,
  type RendererHealthReport,
  type RendererHubOptions,
} from './publisher.js'
export { buildSnapshot, type SnapshotContext } from './snapshot.js'
export {
  ENGINE_STATE_VERSION,
  EngineStateError,
  parseEngineState,
  serializeEngineState,
  type PersistedEngineState,
} from './state.js'
