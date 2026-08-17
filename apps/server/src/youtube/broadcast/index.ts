/**
 * Broadcast lifecycle (spec §9.1, §9.3, §9.4(6), TASK_SPECS §T10). T12's supervisor
 * and T9's chat adapter consume this module; nothing here decides system state.
 */
export {
  YOUTUBE_API_BASE_URL,
  YouTubeApiCallError,
  YouTubeApiShapeError,
  YouTubeLiveApi,
} from './api.js'
export type {
  AccessTokenSource,
  ApiCallOutcome,
  BroadcastListFilter,
  BroadcastTransition,
  ConfigurationIssue,
  InsertBroadcastInput,
  InsertLiveStreamInput,
  LiveBroadcastSummary,
  LiveStreamStatus,
  LiveStreamSummary,
  StreamKeySink,
  StreamListFilter,
  YouTubeLiveApiOptions,
} from './api.js'

export {
  RecordingBroadcastAlertSink,
  nullBroadcastAlertSink,
  nullSafeStopRequestSink,
} from './alerts.js'
export type {
  BroadcastAlert,
  BroadcastAlertKind,
  BroadcastAlertSink,
  SafeStopRequest,
  SafeStopRequestSink,
} from './alerts.js'

export {
  BROADCAST_LATENCY_PREFERENCES,
  BROADCAST_PRIVACY_STATUSES,
  STREAM_FRAME_RATES,
  STREAM_INGESTION_TYPES,
  STREAM_RESOLUTIONS,
  isExperimentalStrategy,
  loadBroadcastConfig,
} from './config.js'
export type {
  BroadcastConfig,
  BroadcastLatencyPreference,
  BroadcastPrivacyStatus,
  IngestionStreamConfig,
  StreamFrameRate,
  StreamIngestionType,
  StreamResolution,
} from './config.js'

export {
  YOUTUBE_BROADCAST_HEALTH_SIGNAL_NAMES,
  YOUTUBE_BROADCAST_LIFECYCLE_SIGNAL,
  YOUTUBE_STREAM_HEALTH_SIGNAL,
  YOUTUBE_STREAM_STATUS_SIGNAL,
  BroadcastHealthMonitor,
  deriveBroadcastHealthSignals,
} from './health.js'
export type {
  BroadcastHealthMonitorOptions,
  BroadcastHealthSample,
} from './health.js'

export {
  ADOPTABLE_LIFE_CYCLE_STATUSES,
  LIVE_LIFE_CYCLE_STATUSES,
  classifyBroadcastLimit,
  isAdoptableLifeCycleStatus,
  isLiveLifeCycleStatus,
} from './limits.js'
export type { BroadcastLimitKind } from './limits.js'

export {
  BroadcastLifecycle,
  BroadcastReconcileFailedError,
  BroadcastSafeStopRequiredError,
  BroadcastStreamInactiveError,
} from './lifecycle.js'
export type {
  BroadcastBinding,
  BroadcastLifecycleOptions,
  BroadcastTarget,
} from './lifecycle.js'

export { StreamKeyCustodian } from './stream-key.js'
