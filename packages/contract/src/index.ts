/**
 * Wire contract shared by @vl/server, @vl/renderer and @vl/simulator.
 *
 * The schemas themselves land in T1 (`[contract]`); T0 only fixes the version
 * constant so every workspace can agree on which contract revision it speaks.
 */
export const CONTRACT_VERSION = 1
