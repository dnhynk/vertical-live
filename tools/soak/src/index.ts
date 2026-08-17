/**
 * `@vl/soak` (TASK_SPECS §T15): the fault matrix of spec §11 as a fixed
 * declaration, the injection hooks that drive every row against a real
 * supervised system, and the 72-hour soak harness in its two clock modes.
 */
export { parseFlags, runCli, USAGE, type CliFlags, type CliResult } from './cli.js'
export {
  loadSoakConfig,
  SoakConfigError,
  type LoadSoakConfigOptions,
  type SoakConfig,
  type SoakMode,
  type SoakRunShape,
  type SoakThresholds,
} from './config.js'
export {
  soakCommandBatch,
  soakCommandEnvelope,
  SOAK_BROADCAST_ID,
  SOAK_LIVE_CHAT_ID,
} from './events.js'
export * from './injection/index.js'
export { FAULT_MATRIX_DOC_PATH, renderFaultMatrixDoc } from './matrix/doc.js'
export {
  FAULT_MATRIX,
  findFaultRow,
  OUTCOME_RULES,
  requireFaultRow,
  type FaultMatrixRow,
} from './matrix/rows.js'
export {
  buildSoakReport,
  formatSoakReport,
  type BuildSoakReportInput,
  type InvariantCheck,
  type SoakCounters,
  type SoakInterruption,
  type SoakLatency,
  type SoakReport,
  type ThresholdCheck,
  type ThresholdOutcome,
} from './soak/report.js'
export {
  RECOVERABLE_FAULTS,
  runSoak,
  SoakConfigurationError,
  type RunSoakOptions,
  type SoakFault,
  type SoakProgress,
} from './soak/run.js'
export {
  SoakSystem,
  soakSupervisorConfig,
  SOAK_BUSY_TIMEOUT_MS,
  type SoakObservation,
  type SoakSystemOptions,
} from './system.js'
