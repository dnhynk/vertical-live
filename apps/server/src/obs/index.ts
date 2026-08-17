/**
 * `@vl/server/obs` — the OBS observation surface (spec §9.4(5)(7)).
 *
 * Published as its own subpath, like `@vl/server/input`, because T15's fault
 * harness has to build §9.4(5)(7) signals the way OBS itself would: RTMPS cut,
 * output stalled, OBS process gone. It uses the **production** derivation so the
 * signal names and reason tokens that reach the supervisor's aggregator are the
 * ones a real encoder produces, not a second set invented by a test double.
 *
 * The client, the control commands and the poller stay unexported: nothing
 * outside this process drives a real OBS socket.
 */
export { OBS_CONNECTION_SIGNAL, type ObsConnectionState } from './client.js'
export {
  loadObsConfig,
  ObsConfigError,
  type LoadObsConfigOptions,
  type ObsConfig,
  type ObsReconnectConfig,
  type ObsThresholdConfig,
} from './config.js'
export {
  deriveObsHealthSignals,
  INITIAL_PROGRESS_STATE,
  OBS_CONGESTION_SIGNAL,
  OBS_FRAMES_SIGNAL,
  OBS_HEALTH_SIGNAL_NAMES,
  OBS_OUTPUT_PROGRESS_SIGNAL,
  OBS_STREAM_SIGNAL,
  unobservableObsHealthSignals,
  type DerivedObsHealth,
  type ObservedAt,
  type ObsOutputSample,
  type ObsProgressState,
} from './health.js'
export { OBS_OUTPUT_STATE, type ObsOutputState } from './protocol.js'
