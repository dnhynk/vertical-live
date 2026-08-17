import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { CONTRACT_VERSION } from '@vl/contract'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

import type { PersistenceStore } from '../db/store.js'
import { createTempStore, type TempStore } from '../db/testing/temp-store.js'
import { createServer } from '../server.js'
import { loadSupervisorConfig } from '../supervisor/config.js'
import { HealthAggregator, MODERATION_HEALTHY } from '../supervisor/signals.js'
import type { DeadManStatus, FamilyVerdict } from '../supervisor/types.js'
import { FakeClock } from '../testing/fake-clock.js'
import { StateEngine } from './engine.js'
import { RendererHub } from './publisher.js'
import {
  at,
  commandEnvelope,
  createEngineHarness,
  ingest,
  resetMessageIds,
  restartEngine,
  superChatEnvelope,
  TEST_CHECKPOINT,
  testInputConfig,
  TEST_EPOCH_MS,
  withEngineConfig,
  type EngineHarness,
} from './testing/harness.js'

/**
 * The publish path when the store refuses `published_at` (T8d — observed while
 * fixing T8c and left outside that ticket's scope).
 *
 * `#publish()` runs **after** `commitStateTransition` has returned: the effect
 * row is already durable when `markEffectPublished()` is attempted. The old
 * order — mark, *then* remember, then send — dropped the effect entirely when
 * that write was refused. The row kept `published_at NULL`, `#openEffects` never
 * received it, so §7.3(7) had nothing to retransmit or expire, the health
 * surface had nothing to report and the renderer never saw it: a paid
 * acknowledgement waited for a restart (spec §9.2, §11 유료 무결성).
 *
 * Both faults below are **real** SQLite failures on a real store, and they are
 * the two write-refusal rows of the §11 fault matrix:
 *
 * - "DB lock" — a second connection holds the write lock, so the production
 *   connection's next write ends in `SQLITE_BUSY` once `busy_timeout` elapses.
 *   This is the fault the live commit path is driven with, because it is the one
 *   that can actually refuse *this* write (see `lockAfterNextEffectCommit`).
 * - "disk-full" — `PRAGMA max_page_count` caps the file at the pages it already
 *   occupies and SQLite answers `SQLITE_FULL` from inside the transaction. The
 *   cap is per connection and is not stored in the file
 *   (https://sqlite.org/pragma.html#pragma_max_page_count, 확인 2026-08-18), so
 *   it is applied to the connection `PersistenceStore` itself opened — the way
 *   T8c's test and T15's drill reach it.
 *
 * `classifySqliteError` maps them to `busy` and `disk_full`, and the engine
 * treats both the same way: they are the store refusing the single writer.
 */

/** The `better-sqlite3` surface these tests need from the production handle. */
interface SqliteConnection {
  pragma(source: string, options?: { readonly simple?: boolean }): unknown
  exec(source: string): unknown
}

const openedConnections = vi.hoisted(() => ({ last: null as SqliteConnection | null }))

vi.mock('../db/open.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/open.js')>()
  return {
    ...actual,
    openDatabase: (options: Parameters<typeof actual.openDatabase>[0]) => {
      const database = actual.openDatabase(options)
      openedConnections.last = database as unknown as SqliteConnection
      return database
    },
  }
})

/** SQLite's own ceiling, i.e. "no cap" (`SQLITE_MAX_PAGE_COUNT`). */
const UNLIMITED_PAGE_COUNT = 4_294_967_294

/**
 * Cuts the connection's page budget to what the file already uses, so the next
 * allocation fails. `VACUUM` first: free pages inside the file are space the
 * engine can still write into, and a cap taken while they exist is a disk that
 * is not actually full.
 */
function fillDisk(connection: SqliteConnection): void {
  connection.exec('VACUUM')
  const pages = Number(connection.pragma('page_count', { simple: true }))
  connection.pragma(`max_page_count = ${String(pages)}`)
}

/** The operator freed space (spec §9.1). */
function freeDisk(connection: SqliteConnection): void {
  connection.pragma(`max_page_count = ${String(UNLIMITED_PAGE_COUNT)}`)
}

function productionConnection(): SqliteConnection {
  const connection = openedConnections.last
  if (connection === null) throw new Error('no store connection was opened')
  return connection
}

/**
 * Takes the database's write lock at the instant the next effect-carrying commit
 * returns — i.e. inside the window this ticket is about, between
 * `commitStateTransition` and `markEffectPublished`.
 *
 * **Why a lock and not a full disk here.** A full file cannot refuse this
 * particular write. `published_at` is an in-place update of a row the commit
 * before it has just inserted, and that row is the last one in the table's
 * b-tree, on a leaf that still has room; SQLite only needs a new page — the only
 * thing `max_page_count` can refuse — when a leaf and its siblings are all full.
 * Measured on this schema before writing these tests: with the file capped after
 * `VACUUM` (slack 0…400 pages, up to 300 paid events) **223 effect rows were
 * committed and every single `published_at` write was recorded**; capping the
 * file the instant a commit returned, with 200 rows already in the outbox,
 * recorded that one too. What a full file does refuse is the *commit*, which
 * fails before the mark is ever reached. The refusal under test therefore has to
 * come from a fault that applies to any write, which is the matrix's other row:
 * another connection holding the write lock (`SQLITE_BUSY` after
 * `busy_timeout`). The disk-full case is covered where it does bite — on rows
 * the file has already packed (`unpublished rows read back on a full disk`).
 *
 * Only the *moment* is arranged. The store, the transaction and the error are
 * real, and a disk filling — or a backup taking the lock — under a live
 * broadcast lands in exactly this window.
 */
function lockAfterNextEffectCommit(store: PersistenceStore, competitor: Database.Database): void {
  const commit = store.commitStateTransition.bind(store)
  store.commitStateTransition = (input) => {
    const result = commit(input)
    // Only the commit that carries effects: `#reconcileInteraction` commits
    // first in a pass and publishes nothing, so locking on that one would starve
    // the transition under test instead of refusing its publish mark.
    if ((input.effects ?? []).length > 0) {
      store.commitStateTransition = commit
      competitor.exec('BEGIN IMMEDIATE')
    }
    return result
  }
}

/**
 * The effect windows have to outlive the fixture: an expired effect leaves the
 * open set, which is a different §7.3(7) path from the one under test.
 */
function testConfig(): ReturnType<typeof withEngineConfig> {
  return withEngineConfig((config) => ({
    ...config,
    engine: {
      ...config.engine,
      effects: { ...config.engine.effects, expiryGraceMs: 3_600_000 },
    },
  }))
}

const SUPERVISOR_CONFIG = loadSupervisorConfig()

const DEAD_MAN_OFF: DeadManStatus = {
  enabled: false,
  lastPushAt: null,
  lastPushOk: null,
  consecutiveFailures: 0,
  lastError: null,
}

/**
 * §9.4(1) as T12 would evaluate it, through the real aggregator: "the field
 * moved" and "the supervisor's verdict moved" are different claims (R-T8c-1).
 */
function coordinatorVerdict(harness: EngineHarness): FamilyVerdict {
  return new HealthAggregator(SUPERVISOR_CONFIG).evaluate({
    engine: harness.engine.health(),
    renderer: null,
    deadMan: DEAD_MAN_OFF,
    moderation: MODERATION_HEALTHY,
    lastEvaluationMonotonicMs: harness.clock.monotonicMs() - SUPERVISOR_CONFIG.evaluateIntervalMs,
    nowUtc: harness.clock.nowUtcIso(),
    nowMonotonicMs: harness.clock.monotonicMs(),
  }).families.coordinator
}

function unpublishedIn(store: PersistenceStore): string[] {
  return store
    .listUnackedEffects()
    .filter((row) => row.publishedAt === null)
    .map((row) => row.effect.effectId)
}

describe('an effect the store will not mark published (§11 "DB lock")', () => {
  let harness: EngineHarness
  let competitor: Database.Database

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness({ config: testConfig() })
    competitor = new Database(harness.temp.file)
  })

  afterEach(() => {
    try {
      competitor.exec('ROLLBACK')
    } catch {
      // The test already released it; the connection still has to close.
    }
    competitor.close()
    harness.dispose()
  })

  it('keeps a paid effect retriable, off the wire and on the health surface', async () => {
    harness.engine.start()
    ingest(harness.engine, [superChatEnvelope({ receivedAt: harness.clock.nowUtcIso() })])
    await harness.clock.advance(1_000)

    lockAfterNextEffectCommit(harness.store, competitor)
    // `pump()` is what the timer calls in production. Before the fix the refused
    // mark came back out of `#publish` and was recorded here as an ordinary
    // failed pass, with the committed row left behind and forgotten.
    harness.engine.pump()

    const refused = unpublishedIn(harness.store)
    // The fixture has to have produced the fault it is about to assert on.
    expect(refused.length).toBeGreaterThan(0)
    expect(
      refused.some((effectId) => harness.store.getEffect(effectId)?.effect.paid === true),
    ).toBe(true)
    expect(harness.engine.health().lastFailure?.error ?? '').toMatch(/database is locked|BUSY/i)

    // Nothing was sent. It must not be: `markEffectAcked` rejects an ACK for a
    // row that does not say it was published, so an effect on the wire ahead of
    // its own row is an acknowledgement that can never be recorded.
    expect(harness.publisher.uniqueEffectIds).not.toEqual(expect.arrayContaining(refused))

    // A pass that has nothing to commit completes even while the lock is held,
    // and the fault has to outlive it — a completed pass says nothing about a
    // publish mark that is still being refused (R-T8c-1 blocker 1). Before the
    // fix this is where the loss became invisible: the row stayed unpublished
    // while `openEffectCount`, `consecutiveFailures` and `degraded` all went
    // back to their healthy values.
    await harness.clock.advance(harness.config.engine.tickIntervalMs)
    harness.engine.pump()

    expect(unpublishedIn(harness.store)).toEqual(expect.arrayContaining(refused))
    const degraded = harness.engine.health()
    // Every outstanding outbox row is accounted for in memory. Before the fix
    // the refused ones were in the store and nowhere else, so this count was
    // short by exactly them.
    expect(degraded.openEffectCount).toBe(harness.store.listUnackedEffects().length)
    expect(degraded.consecutiveFailures).toBeGreaterThanOrEqual(refused.length)
    expect(degraded.degradedReasons).toContain('writer_failing')
    expect(coordinatorVerdict(harness)).toMatchObject({
      status: 'degraded',
      reason: 'writer_failing',
    })
    // The cause stays distinguishable from a failed pass on `/metrics` and in
    // the operator log (`engine.publish_store_failed`).
    expect(harness.engine.metrics().counters['effect_publish_store_failed']).toBeGreaterThanOrEqual(
      refused.length,
    )

    // The lock is gone (spec §9.1). Until the row is written the renderer's ACK
    // is still refused — which is why the mark has to come first.
    competitor.exec('ROLLBACK')
    for (const effectId of refused) harness.engine.onAckEffect(effectId, at(300_000))
    for (const effectId of refused) {
      expect(harness.store.getEffect(effectId)?.ackedAt ?? null).toBeNull()
    }

    // The next pass publishes the row it could not publish before — no restart,
    // no re-ingest — and now the ACK lands.
    await harness.clock.advance(harness.config.engine.tickIntervalMs)
    harness.engine.pump()

    for (const effectId of refused) {
      expect(harness.store.getEffect(effectId)?.publishedAt ?? null).not.toBeNull()
    }
    expect(harness.publisher.uniqueEffectIds).toEqual(expect.arrayContaining(refused))

    for (const effectId of refused) harness.engine.onAckEffect(effectId, at(400_000))
    for (const effectId of refused) {
      expect(harness.store.getEffect(effectId)?.ackedAt ?? null).not.toBeNull()
    }

    await harness.clock.advance(harness.config.engine.tickIntervalMs)
    harness.engine.runPending()
    expect(unpublishedIn(harness.store)).toHaveLength(0)
    expect(harness.engine.health().degradedReasons).not.toContain('writer_failing')
    expect(coordinatorVerdict(harness).status).toBe('ok')
  }, 30_000)

  it('keeps a free effect retriable too', async () => {
    harness.engine.start()
    ingest(harness.engine, [
      commandEnvelope({ command: 'FEED', receivedAt: harness.clock.nowUtcIso() }),
    ])
    await harness.clock.advance(1_000)

    lockAfterNextEffectCommit(harness.store, competitor)
    harness.engine.pump()

    const refused = unpublishedIn(harness.store)
    expect(refused.length).toBeGreaterThan(0)
    expect(
      refused.every((effectId) => harness.store.getEffect(effectId)?.effect.paid === false),
    ).toBe(true)
    expect(harness.publisher.uniqueEffectIds).not.toEqual(expect.arrayContaining(refused))
    expect(harness.engine.health().degradedReasons).toContain('writer_failing')

    competitor.exec('ROLLBACK')
    await harness.clock.advance(harness.config.engine.tickIntervalMs)
    harness.engine.pump()

    expect(unpublishedIn(harness.store)).toHaveLength(0)
    expect(harness.publisher.uniqueEffectIds).toEqual(expect.arrayContaining(refused))
    expect(harness.engine.health().degradedReasons).not.toContain('writer_failing')
  }, 30_000)
})

/**
 * The same refused write on the recovery path (`#adoptRecoveredEffect`), with a
 * genuinely full file (§11 "disk-full").
 *
 * A committed row that was never published is what the crash window of §7.3(7)
 * leaves behind — T15's F-16/F-17 drills park there on purpose — and it is what
 * every refused mark leaves behind until it is repaid. Reading those rows back
 * on a full disk used to throw out of `start()`, and BOARD **A-19** routes this
 * fault to an engine restart: every restart attempt died in the same place
 * instead of spending the budget the policy defines.
 *
 * Nothing is arranged in time here. These rows have been packed by `VACUUM`, so
 * growing one by a `published_at` needs a page the capped file will not give —
 * the same way T8c's ACKs are refused.
 */
describe('unpublished rows read back on a full disk (§11 "disk-full")', () => {
  const PAID_EVENTS = 200
  const PAID_EVENTS_PER_ROUND = 20

  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness({ config: testConfig() })
  })

  afterEach(() => {
    freeDisk(productionConnection())
    harness.dispose()
  })

  it('starts, reports the fault and publishes when space comes back', async () => {
    harness.engine.start()
    for (let round = 0; round < PAID_EVENTS / PAID_EVENTS_PER_ROUND; round += 1) {
      const envelopes = []
      for (let index = 0; index < PAID_EVENTS_PER_ROUND; index += 1) {
        envelopes.push(superChatEnvelope({ receivedAt: harness.clock.nowUtcIso() }))
      }
      ingest(harness.engine, envelopes)
      await harness.clock.advance(1_000)
      harness.engine.runPending()
    }
    const committed = harness.store.listUnackedEffects().map((row) => row.effect.effectId)
    expect(committed.length).toBeGreaterThan(PAID_EVENTS / 2)

    // The durable state a commit whose publish mark never landed leaves behind.
    productionConnection().exec('UPDATE effect_outbox SET published_at = NULL')

    harness = restartEngine(harness, { config: testConfig() })
    const connection = productionConnection()
    fillDisk(connection)
    // Before the fix this throws `SqliteError: database or disk is full` out of
    // `#adoptRecoveredEffect`: the engine cannot start at all, so the restart
    // A-19 asks for cannot even spend its budget.
    harness.engine.start()

    const refused = unpublishedIn(harness.store)
    const recorded = committed.filter((effectId) => !refused.includes(effectId))
    // A full file still takes the writes that fit in free bytes it already has,
    // so the fixture asserts it produced both outcomes.
    expect(refused.length).toBeGreaterThan(0)
    expect(recorded.length).toBeGreaterThan(0)

    // Refused rows are not on the wire; recorded ones are.
    expect(harness.publisher.uniqueEffectIds).not.toEqual(expect.arrayContaining(refused))
    expect(harness.publisher.uniqueEffectIds).toEqual(expect.arrayContaining(recorded))

    const degraded = harness.engine.health()
    expect(degraded.consecutiveFailures).toBeGreaterThanOrEqual(refused.length)
    expect(degraded.openEffectCount).toBe(harness.store.listUnackedEffects().length)
    expect(degraded.degradedReasons).toContain('writer_failing')
    expect(degraded.lastFailure?.error ?? '').toMatch(/database or disk is full|SQLITE_FULL/i)
    expect(coordinatorVerdict(harness).status).toBe('degraded')

    freeDisk(connection)
    await harness.clock.advance(harness.config.engine.tickIntervalMs)
    harness.engine.pump()

    expect(unpublishedIn(harness.store)).toHaveLength(0)
    expect(harness.publisher.uniqueEffectIds).toEqual(expect.arrayContaining(refused))
    expect(harness.engine.health().degradedReasons).not.toContain('writer_failing')
    expect(coordinatorVerdict(harness).status).toBe('ok')
  }, 60_000)
})

describe('a refused publish mark, over /ws/renderer', () => {
  const RENDERER_TOKEN = 'test_renderer_token_t8d'
  let temp: TempStore
  let competitor: Database.Database
  let clock: FakeClock
  let server: Server
  let hub: RendererHub
  let engine: StateEngine
  let baseUrl: string
  let uncaught: unknown[]
  let onUncaught: (error: unknown) => void

  beforeEach(async () => {
    resetMessageIds()
    uncaught = []
    onUncaught = (error) => {
      uncaught.push(error)
    }
    // Without a listener Node prints the exception and exits; with one the test
    // counts what escaped (https://nodejs.org/api/process.html#event-uncaughtexception).
    process.on('uncaughtException', onUncaught)

    clock = new FakeClock({ epochMs: TEST_EPOCH_MS })
    temp = createTempStore({ clock })
    competitor = new Database(temp.file)
    server = createServer({
      engine: { health: () => engine.health(), metrics: () => engine.metrics() },
      rendererHealth: () => hub.lastHealth,
    })
    hub = new RendererHub({
      server,
      clock,
      token: RENDERER_TOKEN,
      events: {
        onHello: (revision) => {
          engine.onRendererHello(revision)
        },
        onAckState: (revision, appliedAt) => {
          engine.onAckState(revision, appliedAt)
        },
        onAckEffect: (effectId, appliedAt) => {
          engine.onAckEffect(effectId, appliedAt)
        },
        onHealth: () => {},
      },
    })
    engine = new StateEngine({
      store: temp.store,
      clock,
      config: testConfig(),
      inputConfig: testInputConfig(),
      publisher: hub,
      autoTick: false,
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterEach(async () => {
    process.off('uncaughtException', onUncaught)
    try {
      competitor.exec('ROLLBACK')
    } catch {
      // Already released by the test body.
    }
    competitor.close()
    engine.stop()
    hub.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    temp.dispose()
  })

  it('shows the renderer nothing until the row is written, then everything', async () => {
    const socket = new WebSocket(
      `${baseUrl.replace('http', 'ws')}/ws/renderer?token=${RENDERER_TOKEN}`,
    )
    const seen = new Set<string>()
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; [key: string]: unknown }
      if (message['type'] === 'snapshot') {
        const snapshot = message['snapshot'] as { stateRevision: number }
        socket.send(
          JSON.stringify({
            schemaVersion: CONTRACT_VERSION,
            type: 'ack_state',
            stateRevision: snapshot.stateRevision,
            appliedAt: at(200_000),
          }),
        )
        return
      }
      if (message['type'] !== 'effect') return
      const effect = message['effect'] as { effectId: string }
      seen.add(effect.effectId)
      // A renderer that applies what it is sent acknowledges it on a real frame.
      socket.send(
        JSON.stringify({
          schemaVersion: CONTRACT_VERSION,
          type: 'ack_effect',
          effectId: effect.effectId,
          appliedAt: at(300_000),
        }),
      )
    })
    socket.send(
      JSON.stringify({
        schemaVersion: CONTRACT_VERSION,
        type: 'hello',
        rendererId: 'renderer_test_t8d',
        lastAppliedStateRevision: null,
      }),
    )
    await waitFor(() => hub.rendererCount === 1, 5_000)

    engine.start()
    engine.ingest([superChatEnvelope({ receivedAt: clock.nowUtcIso() })], TEST_CHECKPOINT)
    await clock.advance(1_000)

    lockAfterNextEffectCommit(temp.store, competitor)
    engine.pump()

    const refused = unpublishedIn(temp.store)
    expect(refused.length).toBeGreaterThan(0)

    // The renderer never saw them, and nothing took the process down.
    expect(uncaught).toHaveLength(0)
    for (const effectId of refused) expect(seen.has(effectId)).toBe(false)

    // The server is still serving, and it says what went wrong (spec §9.2).
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      engine: { consecutiveFailures: number; lastFailure: { error: string } | null }
    }
    expect(health.engine.consecutiveFailures).toBeGreaterThan(0)
    expect(health.engine.lastFailure?.error ?? '').toMatch(/database is locked|BUSY/i)

    // The lock is released: the next pass publishes the row, the renderer plays
    // the effect and its ACK is recorded — the §9.2 paid acknowledgement is not
    // lost and did not need a restart.
    competitor.exec('ROLLBACK')
    await clock.advance(testConfig().engine.tickIntervalMs)
    engine.pump()
    await waitFor(
      () => refused.every((effectId) => temp.store.getEffect(effectId)?.ackedAt != null),
      20_000,
    )

    expect(uncaught).toHaveLength(0)
    for (const effectId of refused) expect(seen.has(effectId)).toBe(true)
    expect(unpublishedIn(temp.store)).toHaveLength(0)
    socket.close()
  }, 60_000)
})

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}
