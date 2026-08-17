import { writeSync } from 'node:fs'
import process from 'node:process'

import {
  loadEngineConfig,
  PersistenceStore,
  simulatorSourceKey,
  StateEngine,
  systemClock,
  type Clock,
  type EnginePublisher,
  type SourceCheckpointInput,
  type TimerHandle,
} from '@vl/server'
import { loadInputConfig } from '@vl/server/input'

import { SOAK_LIVE_CHAT_ID, soakCommandBatch, soakSuperChatEnvelope } from '../events.js'

/**
 * The process that dies, for the crash rows of spec §11 (F-10, F-14 … F-17).
 *
 * It runs the **real** `PersistenceStore` and the **real** `StateEngine` against
 * the database file the parent hands it, drives them to one named commit
 * boundary, reports `ready`, and then blocks the thread forever so the parent's
 * `SIGKILL` lands with the process in exactly that state. Nothing unwinds: no
 * `finally`, no `process.on('exit')`, no SQLite close, and for the boundaries
 * that are inside a transaction, no `COMMIT`.
 *
 * Blocking is `Atomics.wait` on a `SharedArrayBuffer` nobody notifies, which
 * parks the thread without burning a core and — unlike a timer — works from
 * inside a synchronous `better-sqlite3` transaction, which is where two of these
 * boundaries are.
 *
 * It imports the product's own modules rather than writing SQL of its own, so
 * what the parent asserts afterwards is what a real crash of the real engine
 * leaves behind. `child-resolve.mjs` explains how that import works without a
 * build.
 *
 * Usage: node --import child-register.mjs crash-child.ts <dbFile> <mode>
 */

/** One boundary from `matrix/rows.ts`. */
export type CrashChildMode =
  /** F-10: committed state plus an inbox batch the cursor has not passed. */
  | 'host-crash'
  /** F-14: inside `commitIngestBatch`, rows written, checkpoint not reached. */
  | 'inbox-commit'
  /** F-15: the ingest transaction committed, no writer pass yet. */
  | 'state-commit'
  /** F-16: the state transaction committed, nothing published yet. */
  | 'effect-publish'
  /** F-17: the effect marked published, no ACK. */
  | 'effect-ack'

const CRASH_CHILD_MODES: readonly CrashChildMode[] = [
  'host-crash',
  'inbox-commit',
  'state-commit',
  'effect-publish',
  'effect-ack',
]

export function isCrashChildMode(value: string): value is CrashChildMode {
  return (CRASH_CHILD_MODES as readonly string[]).includes(value)
}

/** Parks the thread for good. The parent kills the process from here. */
function reportReadyAndBlockForever(): never {
  writeSync(1, 'ready\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  // Unreachable: nothing ever notifies that buffer.
  throw new Error('crash child was released from Atomics.wait')
}

/**
 * A clock that parks inside its next reading.
 *
 * `commitIngestBatch` reads the clock exactly once — for the checkpoint, after
 * the inbox rows are written — so arming this leaves the process dead **inside**
 * the ingest transaction, which is the F-14 boundary.
 */
class ParkingClock implements Clock {
  parkNextReading = false

  nowUtcIso(): string {
    if (this.parkNextReading) reportReadyAndBlockForever()
    return systemClock.nowUtcIso()
  }

  monotonicMs(): number {
    return systemClock.monotonicMs()
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    return systemClock.setTimeout(handler, delayMs)
  }

  clearTimeout(handle: TimerHandle): void {
    systemClock.clearTimeout(handle)
  }
}

/** A publisher that parks at one of the two publish boundaries (F-16, F-17). */
class ParkingPublisher implements EnginePublisher {
  rendererCount = 1
  parkOnSnapshot = false
  parkOnEffect = false

  // The frames themselves are irrelevant here: this publisher exists to be the
  // place the process dies, not to record anything.
  publishSnapshot(): void {
    if (this.parkOnSnapshot) reportReadyAndBlockForever()
  }

  publishEffect(): void {
    // Reached *after* `markEffectPublished` has committed (engine `#publish`),
    // which is exactly the "published, never acked" window of §7.3(7).
    if (this.parkOnEffect) reportReadyAndBlockForever()
  }
}

const [file, mode] = process.argv.slice(2)
if (file === undefined || mode === undefined || !isCrashChildMode(mode)) {
  process.stderr.write(`usage: crash-child.ts <dbFile> <${CRASH_CHILD_MODES.join('|')}>\n`)
  process.exit(2)
}

const checkpoint = (token: string): SourceCheckpointInput => ({
  sourceKey: simulatorSourceKey(SOAK_LIVE_CHAT_ID),
  liveChatId: SOAK_LIVE_CHAT_ID,
  nextPageToken: token,
})

const clock = new ParkingClock()
const publisher = new ParkingPublisher()
const store = PersistenceStore.open({ file, busyTimeoutMs: 2_000, clock })
const engine = new StateEngine({
  store,
  clock,
  config: loadEngineConfig({ env: {} }),
  inputConfig: loadInputConfig({ env: {} }),
  publisher,
  autoTick: false,
})
engine.start()

const now = (): string => systemClock.nowUtcIso()

/** Sync sleep that does not burn a core; the §6.4 window is wall-clock. */
function sleepSync(millis: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, millis)
}

const BOUNDARIES: Readonly<Record<CrashChildMode, () => void>> = {
  // Park inside the ingest transaction: rows inserted, no COMMIT.
  'inbox-commit': () => {
    clock.parkNextReading = true
    engine.ingest(soakCommandBatch(0, 1, now()), checkpoint('token_never_committed'))
  },

  // The ingest transaction is committed; the writer never runs, so the recovery
  // cursor has not passed the row.
  'state-commit': () => {
    engine.ingest(soakCommandBatch(0, 1, now()), checkpoint('token_committed'))
    reportReadyAndBlockForever()
  },

  'effect-publish': () => {
    publisher.parkOnSnapshot = true
    engine.ingest([soakSuperChatEnvelope(0, now())], checkpoint('token_committed'))
    engine.runPending()
  },

  'effect-ack': () => {
    publisher.parkOnEffect = true
    engine.ingest([soakSuperChatEnvelope(0, now())], checkpoint('token_committed'))
    engine.runPending()
  },

  // A running broadcast: some events processed and committed, and a later batch
  // committed to the inbox that the writer has not drained yet.
  'host-crash': () => {
    engine.ingest(soakCommandBatch(0, 3, now()), checkpoint('token_processed'))
    engine.runPending()
    // The §6.4 aggregation window has to close before those three are recorded
    // as processed, and this child runs on the real clock.
    sleepSync(6_000)
    engine.runPending()
    engine.ingest(soakCommandBatch(3, 2, now()), checkpoint('token_undrained'))
    writeSync(
      1,
      `state ${JSON.stringify({
        stateRevision: engine.health().stateRevision,
        processedIngestSeq: engine.health().processedIngestSeq,
      })}
`,
    )
    reportReadyAndBlockForever()
  },
}

BOUNDARIES[mode]()

// Only the boundaries that park *inside* a call reach this line, and they only
// reach it if the park failed to happen — a broken drill, not a crash.
process.stderr.write(`crash child never reached the ${mode} boundary
`)
process.exit(3)
