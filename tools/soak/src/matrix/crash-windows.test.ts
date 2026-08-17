import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Effect, WorldSnapshot } from '@vl/contract'
import {
  loadEngineConfig,
  PersistenceStore,
  simulatorSourceKey,
  StateEngine,
  type Clock,
  type EnginePublisher,
  type SourceCheckpointInput,
  type TimerHandle,
} from '@vl/server'
import { loadInputConfig } from '@vl/server/input'
import { VirtualClock } from '@vl/simulator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SOAK_LIVE_CHAT_ID, soakCommandEnvelope, soakSuperChatEnvelope } from '../events.js'
import { requireFaultRow } from './rows.js'

/**
 * The four crash windows of spec §11 ("inbox commit·token checkpoint·state
 * commit·effect ACK 사이 각 crash window도 주입한다"), rows F-14 to F-17.
 *
 * These drills need the engine taken to an exact commit boundary and then
 * **rebuilt on the same database file**, which is why they are here rather than
 * with the running-broadcast drills. The process death is modelled by raising at
 * the boundary and abandoning the engine — no `stop()`, no clean SQLite close,
 * nothing that a real crash would have run either — and everything asserted
 * afterwards is read back through a freshly opened store.
 *
 * The OS-level half of the same guarantee (an actual `SIGKILL` with a write
 * transaction open, and what WAL + `synchronous = FULL` leave on disk) is row
 * F-10 in `matrix.test.ts` and T4's own `apps/server/src/db/crash.test.ts`. T15
 * does not re-prove those; it proves that the **engine** recovers from each
 * window without losing or double-applying an event.
 */

/** A clock that raises on the next reading once armed, as T4's ingest test does. */
class ArmableClock implements Clock {
  failNextReading = false
  readonly #inner: VirtualClock

  constructor(inner: VirtualClock) {
    this.#inner = inner
  }

  nowUtcIso(): string {
    if (this.failNextReading) {
      this.failNextReading = false
      throw new Error('injected crash: the process died inside the commit window')
    }
    return this.#inner.nowUtcIso()
  }

  monotonicMs(): number {
    return this.#inner.monotonicMs()
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    return this.#inner.setTimeout(handler, delayMs)
  }

  clearTimeout(handle: TimerHandle): void {
    this.#inner.clearTimeout(handle)
  }
}

/** Publisher that can die exactly where a crash between commit and publish would. */
class RecordingPublisher implements EnginePublisher {
  rendererCount = 1
  crash = false
  readonly snapshots: WorldSnapshot[] = []
  readonly effects: Effect[] = []

  publishSnapshot(snapshot: WorldSnapshot): void {
    if (this.crash) throw new Error('injected crash: the process died before publishing')
    this.snapshots.push(snapshot)
  }

  publishEffect(effect: Effect): void {
    if (this.crash) throw new Error('injected crash: the process died before publishing')
    this.effects.push(effect)
  }
}

const CHECKPOINT: SourceCheckpointInput = {
  sourceKey: simulatorSourceKey(SOAK_LIVE_CHAT_ID),
  liveChatId: SOAK_LIVE_CHAT_ID,
  nextPageToken: 'soak_token_0001',
}

const BUSY_TIMEOUT_MS = 250

interface EngineDrill {
  readonly clock: VirtualClock
  readonly storeClock: ArmableClock
  readonly store: PersistenceStore
  readonly engine: StateEngine
  readonly publisher: RecordingPublisher
}

let directory = ''
let opened: PersistenceStore[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vl-soak-crash-'))
  opened = []
})

afterEach(() => {
  // Every store the drill opened, including the one the "crashed" engine left
  // behind: on Windows an open handle keeps the directory undeletable.
  for (const store of opened) {
    try {
      store.close()
    } catch {
      // Already closed by `reopen`.
    }
  }
  opened = []
  rmSync(directory, { recursive: true, force: true })
})

function openDrill(): EngineDrill {
  const clock = new VirtualClock()
  const storeClock = new ArmableClock(clock)
  const store = PersistenceStore.open({
    file: join(directory, 'vertical-live.db'),
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    clock: storeClock,
  })
  opened.push(store)
  const publisher = new RecordingPublisher()
  const engine = new StateEngine({
    store,
    clock,
    config: loadEngineConfig({ env: {} }),
    inputConfig: loadInputConfig({ env: {} }),
    publisher,
    autoTick: false,
  })
  return { clock, storeClock, store, engine, publisher }
}

/**
 * The restart after the crash. The old engine is **not** stopped and the old
 * store is **not** closed — a crashed process does neither — and the new one
 * opens the same file, which is all that survived.
 */
function reopen(previous: EngineDrill): EngineDrill {
  previous.store.close()
  return openDrill()
}

/** Runs one writer pass and lets the §6.4 aggregation window close (5 s). */
async function settle(drill: EngineDrill): Promise<void> {
  drill.engine.pump()
  await drill.clock.advance(6_000)
  drill.engine.pump()
}

describe('F-14 crash window: inbox commit 전', () => {
  it('leaves no inbox row and no checkpoint, and the event can be received again', async () => {
    const row = requireFaultRow('F-14')
    expect(row.expected).toBe('retry')

    const first = openDrill()
    first.engine.start()
    const envelope = soakCommandEnvelope(0, first.clock.nowUtcIso())

    // `commitIngestBatch` reads the clock once, for the checkpoint, after the
    // inbox rows are written — arming it dies exactly inside that window.
    first.storeClock.failNextReading = true
    expect(() => first.engine.ingest([envelope], CHECKPOINT)).toThrow(/injected crash/)

    const restarted = reopen(first)
    expect(restarted.store.drainUnprocessed(0, 10)).toEqual([])
    expect(restarted.store.getSourceCheckpoint(CHECKPOINT.sourceKey)).toBeNull()
    expect(restarted.store.loadRecoveryState().processedIngestSeq).toBe(0)

    // The source re-delivers it and it is applied exactly once.
    restarted.engine.start()
    restarted.engine.ingest([envelope], CHECKPOINT)
    await settle(restarted)
    expect(restarted.engine.health().processedIngestSeq).toBe(1)
  })
})

describe('F-15 crash window: inbox·checkpoint commit 직후 / state commit 전', () => {
  it('keeps the rows and the resume token, and drains them after the restart', async () => {
    const row = requireFaultRow('F-15')
    expect(row.expected).toBe('retry')

    const first = openDrill()
    first.engine.start()
    first.engine.ingest([soakCommandEnvelope(0, first.clock.nowUtcIso())], CHECKPOINT)

    // The cursor has not moved: the batch is committed but nothing has processed
    // it, which is exactly the window a crash must not bury (spec §7.3(3)(5)).
    expect(first.store.loadRecoveryState().processedIngestSeq).toBe(0)
    expect(first.store.getSourceCheckpoint(CHECKPOINT.sourceKey)?.nextPageToken).toBe(
      CHECKPOINT.nextPageToken,
    )

    const restarted = reopen(first)
    expect(restarted.store.drainUnprocessed(0, 10)).toHaveLength(1)
    restarted.engine.start()
    await settle(restarted)

    expect(restarted.engine.health().processedIngestSeq).toBe(1)
    expect(restarted.store.getSourceCheckpoint(CHECKPOINT.sourceKey)?.nextPageToken).toBe(
      CHECKPOINT.nextPageToken,
    )
  })
})

describe('F-16 crash window: state commit 직후 / effect 발행 전', () => {
  it('keeps the committed state and publishes the effect after the restart', async () => {
    const row = requireFaultRow('F-16')
    expect(row.expected).toBe('retry')

    const first = openDrill()
    first.engine.start()
    first.engine.ingest([soakSuperChatEnvelope(0, first.clock.nowUtcIso())], CHECKPOINT)

    // Commit happens, publishing does not: the process dies between the two.
    first.publisher.crash = true
    first.engine.pump()
    expect(first.engine.health().consecutiveFailures).toBeGreaterThan(0)

    const committed = first.store.loadRecoveryState()
    expect(committed.stateRevision).toBeGreaterThan(0)
    expect(committed.unackedEffects.length).toBeGreaterThan(0)
    const effectId = committed.unackedEffects[0]?.effect.effectId

    const restarted = reopen(first)
    const recovered = restarted.store.loadRecoveryState()
    expect(recovered.stateRevision).toBe(committed.stateRevision)

    restarted.engine.start()
    expect(restarted.publisher.effects.map((effect) => effect.effectId)).toContain(effectId)
  })
})

describe('F-17 crash window: effect 발행 직후 / ACK 전', () => {
  it('recovers the effect as unacked and republishes it under the same id', async () => {
    const row = requireFaultRow('F-17')
    expect(row.expected).toBe('retry')

    const first = openDrill()
    first.engine.start()
    first.engine.ingest([soakSuperChatEnvelope(0, first.clock.nowUtcIso())], CHECKPOINT)
    first.engine.pump()

    const open = first.store.listUnackedEffects()
    expect(open.length).toBeGreaterThan(0)
    expect(open.every((entry) => entry.publishedAt !== null && entry.ackedAt === null)).toBe(true)
    const publishedIds = open.map((entry) => entry.effect.effectId).sort()

    const restarted = reopen(first)
    restarted.engine.start()

    // The same `effectId`s, each republished exactly once, so a renderer that
    // already played one does not start the staging again (spec §7.3(7), §11
    // 유료 무결성).
    expect(restarted.publisher.effects.map((effect) => effect.effectId).sort()).toEqual(
      publishedIds,
    )
    expect(
      restarted.store
        .listUnackedEffects()
        .map((entry) => entry.effect.effectId)
        .sort(),
    ).toEqual(publishedIds)
  })
})
