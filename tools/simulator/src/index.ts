/**
 * `@vl/simulator` (TASK_SPECS §T11): scenario files → `POST /ingest/simulator`,
 * virtual-clock replay, and the per-stage latency report.
 *
 * The browser-safe half is also published on its own as `@vl/simulator/scenario`
 * so the renderer's `?mode=dev` panel can build the same envelopes without
 * pulling in `@vl/server`.
 */
export { allScenarios, parseFlags, runCli, USAGE, type CliResult } from './cli.js'
export * from './scenario/index.js'
export * from './runner/index.js'
export * from './report/index.js'
