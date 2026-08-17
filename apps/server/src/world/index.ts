/**
 * `@vl/server` world model (TASK_SPECS §T7): the pure content director.
 *
 * Nothing in this folder performs I/O, reads a clock or starts a timer. The
 * state engine (T8) wraps `step()` with persistence, WebSocket publication and
 * ACK tracking; the renderer (T5/T14) reads the projection in `project.ts`.
 */
export * from './types.js'
export * from './time.js'
export * from './rng.js'
export * from './deadlines.js'
export * from './creature.js'
export * from './choices.js'
export * from './paid.js'
export * from './variation.js'
export * from './reducer.js'
export * from './project.js'
export * from './run.js'
export * from './content/index.js'
