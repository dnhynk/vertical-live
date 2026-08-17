/**
 * Fault injection hooks (TASK_SPECS §T15 "주입 hook(테스트/플래그 전용)").
 *
 * Every hook lives here, in a tool package, and none of them is reachable from
 * `apps/server`'s production wiring: T12 already expressed the collaborators as
 * ports (`ObsPort`, `BroadcastPort`, `ChatPort`, `PreflightProbes`,
 * `ComponentActions`), so a fault is injected by handing the supervisor a
 * different adapter rather than by adding a failure branch to the real one.
 *
 * Where the failure has to be genuine to mean anything — a `SQLITE_BUSY` from a
 * real lock, a `SQLITE_FULL` from SQLite itself, an `invalid_grant` from a real
 * token endpoint over real HTTP, a real `SIGKILL` — it is.
 */
export { FaultyAuth, type FaultyAuthOptions } from './auth.js'
export { FaultyBroadcast, type BroadcastFault, type FaultyBroadcastOptions } from './broadcast.js'
export { FaultyChat, type ChatFault, type FaultyChatOptions } from './chat.js'
export { crashChild, type CrashChildMode, type CrashResult } from './crash.js'
export { FaultyObs, type FaultyObsOptions, type ObsFault } from './obs.js'
export { SoakRenderer, type SoakRendererOptions } from './renderer.js'
export {
  fillDisk,
  freeDisk,
  UNLIMITED_PAGE_COUNT,
  WriteLockHolder,
  type SqliteConnection,
} from './storage.js'
