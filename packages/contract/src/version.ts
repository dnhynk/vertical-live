/**
 * Revision of the wire contract shared by @vl/server, @vl/renderer and
 * @vl/simulator. Every persisted or transmitted contract object carries it as
 * `schemaVersion` so a stored inbox row can be read back by a later build.
 *
 * Lives in its own module (and is re-exported from `index.ts`) because the
 * schemas below embed it, and importing the barrel from them would be a cycle.
 */
export const CONTRACT_VERSION = 1
