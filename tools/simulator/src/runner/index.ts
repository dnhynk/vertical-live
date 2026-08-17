/**
 * Node-side runner: the in-process backend, the virtual clock, the stub
 * renderer, the HTTP injection client and the scenario loop. Everything here
 * imports `@vl/server`, so none of it is reachable from a browser bundle — the
 * `?mode=dev` panel uses `@vl/simulator/scenario` instead.
 */
export {
  ADVERSARIAL_SCENARIO_ID,
  SIMULATOR_PARSE_CONTEXT,
  buildAdversarialScenario,
  simulatorCommandParser,
  type CommandParserOptions,
} from './adversarial.js'
export {
  VIRTUAL_EPOCH_MS,
  VirtualClock,
  flushEventLoop,
  type VirtualClockOptions,
} from './clock.js'
export {
  HARNESS_BUSY_TIMEOUT_MS,
  SimulatorHarness,
  type SimulatorHarnessOptions,
} from './harness.js'
export {
  MAX_ENVELOPES_PER_POST,
  postEnvelopeBatch,
  postEnvelopes,
  type InjectResponse,
  type InjectTarget,
} from './inject.js'
export { DEFAULT_SLICE_MS, runScenario, type RunOptions, type RunResult } from './run.js'
export { openSession, type SessionOptions, type SimulatorSession } from './session.js'
export { StubRenderer, type ObservedEffect, type StubRendererOptions } from './stub-renderer.js'
