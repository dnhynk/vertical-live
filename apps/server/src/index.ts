export {
  createServer,
  handleRequest,
  resolvePort,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type EngineHttpPort,
  type ServerOptions,
} from './server.js'
export { systemClock, type Clock, type TimerHandle } from './clock.js'
// The health vocabulary is already part of the public surface — `ServerOptions`
// and every producer are typed with it — so it is exported by name rather than
// left reachable only through a deep import.
export type {
  HealthComponent,
  HealthDetailValue,
  HealthSignal,
  HealthSignalSink,
  HealthStatus,
} from './health/types.js'
export * from './db/index.js'
export * from './engine/index.js'
// `./input/index.js` is deliberately *not* re-exported here: it and
// `./world/types.js` both own a `RejectionReason`, and collapsing the two into
// one barrel would make the ambiguity a compile error for every consumer. The
// input module is published on its own path (`@vl/server/input`), which is what
// T11's simulator imports to replay raw text through the real parser.
export {
  SimulatorIngestEndpoint,
  isLoopbackAddress,
  simulatorSourceKey,
  type InboxWriter,
  type SimulatorIngestOptions,
  type SimulatorIngestRequest,
  type SimulatorIngestResponse,
} from './engine/ingest.js'
export * from './privacy/index.js'
export * from './secrets/index.js'
export * from './world/index.js'
export * from './youtube/index.js'
