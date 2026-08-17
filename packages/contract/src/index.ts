/**
 * Wire contract shared by @vl/server, @vl/renderer and @vl/simulator.
 *
 * The zod schemas here are the source of truth; `schema/*.json` is generated
 * from them (see `src/schema/registry.ts`). Two entry points are intentionally
 * not re-exported: `./schema/registry.js` (build-time only) and
 * `@vl/contract/fixtures` (Node-only fixture loader).
 */
export { CONTRACT_VERSION } from './version.js'
export * from './primitives.js'
export * from './enums.js'
export * from './commands.js'
export * from './ingest.js'
export * from './event.js'
export * from './effect.js'
export * from './snapshot.js'
export * from './ws.js'
export * from './adapters/grpc.js'
export * from './adapters/rest.js'
export type { IngestAdapterContext } from './adapters/shared.js'
