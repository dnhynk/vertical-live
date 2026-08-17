import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { CONTRACT_VERSION } from '@vl/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

import { createTempStore, type TempStore } from '../db/testing/temp-store.js'
import { createServer } from '../server.js'
import { loadSupervisorConfig } from '../supervisor/config.js'
import { HealthAggregator, MODERATION_HEALTHY } from '../supervisor/signals.js'
import {
  createSupervisorHarness,
  passingPreflight,
  type SupervisorHarness,
} from '../supervisor/testing/harness.js'
import type { DeadManStatus, FamilyVerdict } from '../supervisor/types.js'
import { FakeClock, flushMicrotasks } from '../testing/fake-clock.js'
import { StateEngine } from './engine.js'
import { RendererHub } from './publisher.js'
import {
  at,
  createEngineHarness,
  ingest,
  RecordingPublisher,
  resetMessageIds,
  superChatEnvelope,
  testInputConfig,
  TEST_EPOCH_MS,
  withEngineConfig,
  type EngineHarness,
} from './testing/harness.js'

/**
 * The renderer ACK path when the store refuses the write (T8c, found by T15's
 * F-12 disk-full drill).
 *
 * `ack_effect` arrives on a WebSocket `message` listener, which `ws` calls
 * synchronously while it processes socket data. An exception thrown there is
 * inside no try/catch: it unwinds to the top of the event loop and Node
 * terminates the process unless something has registered `uncaughtException`
 * (https://nodejs.org/api/process.html#event-uncaughtexception, 확인 2026-08-18).
 * `markEffectAcked` is a write — `UPDATE effect_outbox SET acked_at` — so a full
 * disk, a lock or an I/O error on that one frame took the whole broadcast down,
 * which spec §9.2 rules out: the run degrades and says why, it does not vanish.
 *
 * The fault is **real**, not simulated. `PRAGMA max_page_count` caps the file at
 * the pages it already occupies and SQLite then answers `SQLITE_FULL` from
 * inside the transaction. The cap is per connection and is not stored in the
 * file (https://sqlite.org/pragma.html#pragma_max_page_count, 확인 2026-08-18),
 * so it has to be applied to the connection `PersistenceStore` itself opened —
 * hence the `openDatabase` wrapper below, which is how T15's drill reaches the
 * same connection.
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
 * How many paid events the fixture commits, i.e. how many effects are open when
 * the disk fills.
 *
 * A full file does not refuse *every* write: an `UPDATE` that fits in the free
 * bytes its own b-tree page still has commits normally. Measured on this schema
 * (`dbstat`, 4 KiB pages): after `VACUUM` an `effect_outbox` leaf holds ~20 rows
 * and keeps ~180 unused bytes, while writing `acked_at` grows a row by ~24
 * bytes — so a two-leaf outbox absorbs every ACK and a small fixture would prove
 * nothing. At this size the free bytes are out of reach of most rows: 94 of 201
 * ACKs were refused with a genuine `SQLITE_FULL`, the first on the second ACK.
 */
const PAID_EVENTS = 200
const PAID_EVENTS_PER_ROUND = 20

/**
 * Commits `PAID_EVENTS` paid events, each of which stages one acknowledgement
 * effect that stays open until the renderer acks it.
 *
 * Every envelope is stamped from the injected clock rather than from the
 * harness epoch, because the supervisor fixture below runs the engine on T12's
 * clock and an event dated months ahead of `now` is a different §7.3(3) path.
 */
async function commitOpenEffects(engine: StateEngine, clock: FakeClock): Promise<void> {
  for (let round = 0; round < PAID_EVENTS / PAID_EVENTS_PER_ROUND; round += 1) {
    const envelopes = []
    for (let index = 0; index < PAID_EVENTS_PER_ROUND; index += 1) {
      envelopes.push(superChatEnvelope({ receivedAt: clock.nowUtcIso() }))
    }
    ingest(engine, envelopes)
    await clock.advance(1_000)
    engine.runPending()
  }
}

/**
 * The effect windows have to outlive the fixture: an expired effect is swept out
 * of the open set and stops being an ACK the renderer can still send, which is a
 * different §7.3(7) path from the one under test.
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

describe('renderer ACK refused by the store', () => {
  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness({ config: testConfig() })
  })

  afterEach(() => {
    freeDisk(productionConnection())
    harness.dispose()
  })

  it('records the failure, keeps the effect open and re-acks once space is free', async () => {
    harness.engine.start()
    await commitOpenEffects(harness.engine, harness.clock)
    const open = harness.store.listUnackedEffects().map((entry) => entry.effect.effectId)
    expect(open.length).toBeGreaterThan(PAID_EVENTS / 2)

    const connection = productionConnection()
    fillDisk(connection)

    // Before the fix this throws out of `onAckEffect`; on the wire that throw is
    // an uncaught exception in a `ws` listener, i.e. a dead process.
    for (const effectId of open) harness.engine.onAckEffect(effectId, at(200_000))

    const refused = open.filter((effectId) => harness.store.getEffect(effectId)?.ackedAt == null)
    const recorded = open.filter((effectId) => harness.store.getEffect(effectId)?.ackedAt != null)
    // The fixture has to have produced the fault: a full disk that refused
    // nothing would make every assertion below vacuous.
    expect(refused.length).toBeGreaterThan(0)
    expect(recorded.length).toBeGreaterThan(0)

    // The failure is on the engine's health surface, which is what T12's
    // aggregator reads (`supervisor/signals.ts`, coordinator signal).
    const health = harness.engine.health()
    expect(health.consecutiveFailures).toBeGreaterThan(0)
    expect(health.lastFailure?.error ?? '').toMatch(/database or disk is full|SQLITE_FULL/i)
    expect(health.degradedReasons).toContain('writer_failing')
    expect(harness.engine.metrics().counters['ack_effect_store_failed']).toBe(refused.length)
    expect(harness.engine.metrics().counters['ack_effect']).toBe(recorded.length)

    // A refused ACK stays retriable: the effect is still open, so §7.3(7)
    // retransmits it and the renderer acknowledges it again.
    expect(health.openEffectCount).toBe(refused.length)
    expect(harness.store.listUnackedEffects().map((entry) => entry.effect.effectId)).toEqual(
      expect.arrayContaining(refused),
    )

    freeDisk(connection)
    for (const effectId of refused) harness.engine.onAckEffect(effectId, at(300_000))

    expect(
      refused.filter((effectId) => harness.store.getEffect(effectId)?.ackedAt == null),
    ).toHaveLength(0)
    expect(harness.engine.health().openEffectCount).toBe(0)
    expect(harness.store.listUnackedEffects()).toHaveLength(0)
  }, 30_000)

  it('still ignores an ACK for an effect this server never published', () => {
    harness.engine.start()
    harness.engine.onAckEffect('eff_test_never_published', at(1_000))

    expect(harness.engine.metrics().counters['ack_effect_unknown']).toBe(1)
    // An unknown id is the renderer's view of another run, not a store fault.
    expect(harness.engine.health().lastFailure).toBeNull()
    expect(harness.engine.metrics().counters['ack_effect_store_failed']).toBeUndefined()
  })
})

const SUPERVISOR_CONFIG = loadSupervisorConfig()

const DEAD_MAN_OFF: DeadManStatus = {
  enabled: false,
  lastPushAt: null,
  lastPushOk: null,
  consecutiveFailures: 0,
  lastError: null,
}

/**
 * §9.4(1) as T12 would evaluate it right now.
 *
 * The assertions go through the real `HealthAggregator` rather than stopping at
 * `engine.health()`, because the aggregator is the code a §9.2 transition is
 * decided on — "the field moved" and "the supervisor's verdict moved" are not
 * the same claim, and review round 1 found exactly that gap.
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

/**
 * How long the failure stays readable, and by whom (review round 1, blocker 1).
 *
 * The two clocks that matter are not the same: the writer pass runs every
 * `engine.tickIntervalMs` (250ms, `config/default.json`) and T12 evaluates every
 * `supervisor.evaluateIntervalMs` (2000ms) — eight passes to every evaluation.
 * A pass with nothing to commit writes nothing and completes, so a fault that a
 * completed pass clears can be gone again before the aggregator ever reads it.
 */
describe('an ACK the store refused, as T12 reads it', () => {
  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness({ config: testConfig() })
  })

  afterEach(() => {
    freeDisk(productionConnection())
    harness.dispose()
  })

  it('stays degraded across successful writer passes and clears when the ACK lands', async () => {
    harness.engine.start()
    await commitOpenEffects(harness.engine, harness.clock)
    const open = harness.store.listUnackedEffects().map((entry) => entry.effect.effectId)

    const connection = productionConnection()
    fillDisk(connection)
    for (const effectId of open) harness.engine.onAckEffect(effectId, at(200_000))
    const refused = open.filter((effectId) => harness.store.getEffect(effectId)?.ackedAt == null)
    expect(refused.length).toBeGreaterThan(0)
    expect(coordinatorVerdict(harness)).toMatchObject({
      status: 'degraded',
      reason: 'writer_failing',
    })

    // The operator freed the space (spec §9.1), so the writer works again — but
    // the renderer has not re-acknowledged: `acked_at` is still NULL and the
    // effect is still open, so the read model still has no proof of delivery.
    freeDisk(connection)

    // Two whole supervisor evaluation intervals of passes that all complete.
    // `runPending()` rethrows, so a pass that failed here would fail the test
    // and this loop could not be mistaken for the failure staying alive.
    const tickMs = harness.config.engine.tickIntervalMs
    const passes = Math.ceil((SUPERVISOR_CONFIG.evaluateIntervalMs * 2) / tickMs)
    for (let pass = 0; pass < passes; pass += 1) {
      await harness.clock.advance(tickMs)
      harness.engine.runPending()
    }

    const degraded = harness.engine.health()
    expect(degraded.consecutiveFailures).toBe(refused.length)
    expect(degraded.degradedReasons).toContain('writer_failing')
    expect(degraded.openEffectCount).toBe(refused.length)
    expect(coordinatorVerdict(harness)).toMatchObject({
      status: 'degraded',
      reason: 'writer_failing',
    })

    // The renderer's own ACK is the evidence that clears it — and it clears
    // completely, so a recovered store leaves no false-degraded lock behind.
    for (const effectId of refused) harness.engine.onAckEffect(effectId, at(300_000))
    await harness.clock.advance(tickMs)
    harness.engine.runPending()

    const recovered = harness.engine.health()
    expect(recovered.consecutiveFailures).toBe(0)
    expect(recovered.degradedReasons).not.toContain('writer_failing')
    expect(recovered.openEffectCount).toBe(0)
    expect(coordinatorVerdict(harness).status).toBe('ok')
  }, 60_000)
})

/**
 * The other way a refused ACK ends: §7.3(7) expires the effect.
 *
 * The reason this needs its own test is that the fault has to be *durable*, and
 * anything durable can latch. Once the window closes there is no retransmit for
 * the renderer to answer, so no future ACK could ever clear the fault — a
 * condition kept until "the ACK succeeds" would then be permanent, and a
 * permanently degraded engine holds every event in the inbox (spec §9.2).
 */
describe('an ACK the store refused, for an effect that then expired', () => {
  /** Long enough to outlive the fixture, short enough to close inside the test. */
  const EXPIRY_GRACE_MS = 60_000

  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness({
      config: withEngineConfig((config) => ({
        ...config,
        engine: {
          ...config.engine,
          effects: { ...config.engine.effects, expiryGraceMs: EXPIRY_GRACE_MS },
        },
      })),
    })
  })

  afterEach(() => {
    freeDisk(productionConnection())
    harness.dispose()
  })

  it('stops reporting a fault that no ACK can clear any more', async () => {
    harness.engine.start()
    await commitOpenEffects(harness.engine, harness.clock)
    const open = harness.store.listUnackedEffects().map((entry) => entry.effect.effectId)

    const connection = productionConnection()
    fillDisk(connection)
    for (const effectId of open) harness.engine.onAckEffect(effectId, at(200_000))
    const refused = open.filter((effectId) => harness.store.getEffect(effectId)?.ackedAt == null)
    expect(refused.length).toBeGreaterThan(0)
    expect(coordinatorVerdict(harness).status).toBe('degraded')

    // Space came back, but nobody re-acknowledged before the windows closed.
    freeDisk(connection)
    await harness.clock.advance(EXPIRY_GRACE_MS + 30_000)
    harness.engine.runPending()

    // `expired_at` is written, spec §9.2 substitute staging owns what happens
    // next, and the engine is no longer claiming a write it is waiting on. The
    // open set is not empty — the beats that ran during those 90 seconds staged
    // effects of their own — so what is asserted is that no *refused* ACK is
    // still outstanding.
    expect(
      refused.filter((effectId) => harness.store.getEffect(effectId)?.expiredAt == null),
    ).toHaveLength(0)
    expect(harness.engine.metrics().counters['effect_expired']).toBeGreaterThanOrEqual(
      refused.length,
    )
    expect(harness.engine.health().consecutiveFailures).toBe(0)
    expect(harness.engine.health().degradedReasons).not.toContain('writer_failing')
    expect(coordinatorVerdict(harness).status).toBe('ok')
  }, 60_000)
})

/**
 * The expiry write itself refused (R-T8c-2 blocker 1).
 *
 * `#sweepEffects()` used to drop the effect from `#openEffects` and from the
 * ACK-failure set *before* `markEffectExpired()` had written anything. When the
 * store refused that write the row kept `acked_at: null, expired_at: null`
 * while nothing in memory pointed at it any more: the next pass with nothing to
 * commit completed, the shared writer counter went back to 0, and `/health`
 * reported `openEffectCount: 0` and `degraded: false` over an outbox row that
 * was neither delivered nor expired — the §7.3(7) retransmit and the expiry
 * were both lost until a restart re-read the outbox.
 */
describe('the §7.3(7) expiry the store refused', () => {
  /**
   * Chosen so the windows outlive the fixture — the first effect ends at 9s and
   * `commitOpenEffects` runs to 10s — and close well before the world's first
   * idle beat (`tuning.idleBeat.minIntervalMs`, 30s).
   */
  const EXPIRY_GRACE_MS = 5_000
  /** Just short of the first window closing (9s + the grace). */
  const DRAIN_AT_MS = 13_900
  /** Past the last window (18s) plus the grace, and still short of the beat. */
  const SWEEP_AT_MS = 23_500

  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness({
      config: withEngineConfig((config) => ({
        ...config,
        engine: {
          ...config.engine,
          effects: { ...config.engine.effects, expiryGraceMs: EXPIRY_GRACE_MS },
        },
      })),
    })
  })

  afterEach(() => {
    freeDisk(productionConnection())
    harness.dispose()
  })

  it('keeps the effect open and the fault reported until the row is written', async () => {
    harness.engine.start()
    await commitOpenEffects(harness.engine, harness.clock)
    const open = harness.store.listUnackedEffects().map((entry) => entry.effect.effectId)

    const connection = productionConnection()
    fillDisk(connection)
    for (const effectId of open) harness.engine.onAckEffect(effectId, harness.clock.nowUtcIso())
    const refused = open.filter((effectId) => harness.store.getEffect(effectId)?.ackedAt == null)
    expect(refused.length).toBeGreaterThan(0)

    // The sweep is the **last** thing a pass does, so a pass that still owes a
    // commit fails before reaching it — including the interaction-gate commit
    // that `writer_failing` itself triggers. The world is therefore drained
    // while there is still space and the file is refilled immediately after, so
    // that the expiry below is the first write its pass attempts and the
    // refusal under test is a real `SQLITE_FULL` rather than a side effect of
    // some other write failing first.
    freeDisk(connection)
    await harness.clock.advance(DRAIN_AT_MS - harness.clock.monotonicMs())
    for (let pass = 0; pass < 40 && harness.engine.runPending() > 0; pass += 1);
    fillDisk(connection)

    // Every window is closed now, so this pass sweeps all of them — onto the
    // same full file that refused their ACKs. `pump()` is what the timer calls
    // in production: before the fix the throw came back out of the sweep and
    // was recorded here as an ordinary failed pass, which is the failure this
    // test has to survive to reach the assertions below.
    await harness.clock.advance(SWEEP_AT_MS - harness.clock.monotonicMs())
    harness.engine.pump()

    const expiryRefused = refused.filter(
      (effectId) => harness.store.getEffect(effectId)?.expiredAt == null,
    )
    // The fixture has to have produced the fault it is about to assert on.
    expect(expiryRefused.length).toBeGreaterThan(0)

    // The pass that used to wipe the fault: nothing is due and nothing needs a
    // commit, so it completes even with the disk still full. `runPending()`
    // rethrows, so this line failing would mean the pass did *not* complete and
    // the assertions after it would be about something else.
    await harness.clock.advance(harness.config.engine.tickIntervalMs)
    harness.engine.runPending()

    // Before the fix: `ackedAt: null, expiredAt: null` with `consecutiveFailures
    // 0`, `degraded false`, `openEffectCount 0`. Now the row and the health
    // surface agree — the write is still owed, so it is still reported.
    for (const effectId of expiryRefused) {
      const row = harness.store.getEffect(effectId)
      expect(row?.ackedAt ?? null).toBeNull()
      expect(row?.expiredAt ?? null).toBeNull()
    }
    const degraded = harness.engine.health()
    expect(degraded.consecutiveFailures).toBe(expiryRefused.length)
    expect(degraded.degradedReasons).toContain('writer_failing')
    expect(degraded.openEffectCount).toBe(expiryRefused.length)
    expect(harness.store.listUnackedEffects().map((entry) => entry.effect.effectId)).toEqual(
      expect.arrayContaining(expiryRefused),
    )
    expect(degraded.lastFailure?.error ?? '').toMatch(/database or disk is full|SQLITE_FULL/i)
    expect(harness.engine.metrics().counters['effect_expiry_store_failed']).toBeGreaterThan(0)
    expect(coordinatorVerdict(harness)).toMatchObject({
      status: 'degraded',
      reason: 'writer_failing',
    })

    // The operator freed the space (spec §9.1). The next sweep writes the rows
    // it could not write before — no restart, no re-ingest — and the fault
    // clears completely, so nothing latches for the rest of the run.
    freeDisk(connection)
    await harness.clock.advance(harness.config.engine.tickIntervalMs)
    harness.engine.runPending()

    expect(
      expiryRefused.filter((effectId) => harness.store.getEffect(effectId)?.expiredAt == null),
    ).toHaveLength(0)
    const recovered = harness.engine.health()
    expect(recovered.consecutiveFailures).toBe(0)
    expect(recovered.degradedReasons).not.toContain('writer_failing')
    expect(recovered.openEffectCount).toBe(0)
    expect(coordinatorVerdict(harness).status).toBe('ok')
  }, 60_000)
})

describe('renderer ACK refused by the store, over /ws/renderer', () => {
  const RENDERER_TOKEN = 'test_renderer_token_t8c'
  let temp: TempStore
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
    // Without a listener Node prints the exception and exits, which is the
    // production failure itself; with one the test can count what escaped.
    process.on('uncaughtException', onUncaught)

    clock = new FakeClock({ epochMs: TEST_EPOCH_MS })
    temp = createTempStore({ clock })
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
    freeDisk(productionConnection())
    engine.stop()
    hub.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    temp.dispose()
  })

  it('survives an ack_effect frame the store cannot record', async () => {
    // A renderer that applies what it is sent: it acknowledges every snapshot,
    // and every effect once it has presented a frame — which the test decides,
    // because the ACKs under test have to arrive after the disk is full.
    const socket = new WebSocket(
      `${baseUrl.replace('http', 'ws')}/ws/renderer?token=${RENDERER_TOKEN}`,
    )
    const seen = new Set<string>()
    let ackOnReceive = false
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const ackEffect = (effectId: string): void => {
      socket.send(
        JSON.stringify({
          schemaVersion: CONTRACT_VERSION,
          type: 'ack_effect',
          effectId,
          appliedAt: at(200_000),
        }),
      )
    }
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
      if (ackOnReceive) ackEffect(effect.effectId)
    })
    socket.send(
      JSON.stringify({
        schemaVersion: CONTRACT_VERSION,
        type: 'hello',
        rendererId: 'renderer_test_t8c',
        lastAppliedStateRevision: null,
      }),
    )
    await waitFor(() => hub.rendererCount === 1, 5_000)

    engine.start()
    await commitOpenEffects(engine, clock)
    const open = temp.store.listUnackedEffects().map((entry) => entry.effect.effectId)
    expect(open.length).toBeGreaterThan(PAID_EVENTS / 2)
    await waitFor(() => open.every((effectId) => seen.has(effectId)), 20_000)

    const connection = productionConnection()
    fillDisk(connection)
    for (const effectId of open) ackEffect(effectId)

    const settled = (): number =>
      (engine.metrics().counters['ack_effect'] ?? 0) +
      (engine.metrics().counters['ack_effect_store_failed'] ?? 0)
    await waitFor(() => uncaught.length > 0 || settled() >= open.length, 20_000)

    // The frame did not take the process down.
    expect(uncaught).toHaveLength(0)
    expect(seen.size).toBe(open.length)
    const refused = open.filter((effectId) => temp.store.getEffect(effectId)?.ackedAt == null)
    expect(refused.length).toBeGreaterThan(0)

    // The server is still serving, and it says what went wrong.
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      engine: { consecutiveFailures: number; lastFailure: { error: string } | null }
    }
    expect(health.engine.consecutiveFailures).toBeGreaterThan(0)
    expect(health.engine.lastFailure?.error ?? '').toMatch(/database or disk is full|SQLITE_FULL/i)

    // Space comes back and the retransmit of §7.3(7) closes the gap, without
    // anyone re-sending the original event.
    freeDisk(connection)
    ackOnReceive = true
    await clock.advance(testConfig().engine.effects.retransmitIntervalMs + 1_000)
    engine.runPending()
    await waitFor(() => temp.store.listUnackedEffects().length === 0, 20_000)

    expect(engine.health().openEffectCount).toBe(0)
    expect(uncaught).toHaveLength(0)
    socket.close()
  }, 60_000)
})

describe('renderer hub, when a handler throws', () => {
  let server: Server
  let hub: RendererHub
  let baseUrl: string
  let uncaught: unknown[]
  let onUncaught: (error: unknown) => void
  const RENDERER_TOKEN = 'test_renderer_token_t8c_hub'

  afterEach(async () => {
    process.off('uncaughtException', onUncaught)
    hub.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('keeps the process and the connection alive', async () => {
    uncaught = []
    onUncaught = (error) => {
      uncaught.push(error)
    }
    process.on('uncaughtException', onUncaught)

    const clock = new FakeClock({ epochMs: TEST_EPOCH_MS })
    const logged: string[] = []
    server = createServer({})
    hub = new RendererHub({
      server,
      clock,
      token: RENDERER_TOKEN,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (event: string) => logged.push(event),
      },
      events: {
        onHello: () => {},
        onAckState: () => {
          throw new Error('handler failed')
        },
        onAckEffect: () => {},
        onHealth: () => {},
      },
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

    const socket = new WebSocket(
      `${baseUrl.replace('http', 'ws')}/ws/renderer?token=${RENDERER_TOKEN}`,
    )
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(
      JSON.stringify({
        schemaVersion: CONTRACT_VERSION,
        type: 'ack_state',
        stateRevision: 1,
        appliedAt: at(1_000),
      }),
    )
    await waitFor(() => logged.includes('renderer.frame_handler_failed'), 5_000)

    expect(uncaught).toHaveLength(0)
    expect(hub.rendererCount).toBe(1)
    socket.close()
  }, 20_000)
})

/**
 * What T12 actually *does* with the signal (BOARD **A-19**, R-T8c-2 major).
 *
 * `EngineHealth.consecutiveFailures > 0` is not only an observation: it is the
 * coordinator family, `transitions.ts` routes that family to the engine restart
 * supervisor, and `config/default.json` gives that supervisor three attempts
 * before `safe_stopped`. Restarting the engine — `engine.stop(); engine.start()`
 * in `main.ts` — cannot make a full disk take a write, so the run ends stopped.
 *
 * BOARD A-19 decides that this is the intended policy: a refused ACK is the same
 * store failure as a refused writer pass (same connection, same classifier), and
 * fault-matrix F-12 (disk-full → degraded) escalating to F-18 (`safe_stopped`)
 * once the budget is spent is what T12 and T15 already fixed. No non-restarting
 * family is invented for it and no supervisor file changes; these two tests are
 * the evidence that the policy behaves as decided, in both directions.
 *
 * The supervisor here is the real one, with the real transition rules, the real
 * restart budget and the real safe-stop path. The only thing flattened is the
 * backoff delay, so the budget can be spent without advancing the fake clock
 * past the other families' freshness windows.
 */
describe('the supervisor recovery attached to a refused ACK (BOARD A-19)', () => {
  const RESTART_DELAY_MS = 500

  let harness: SupervisorHarness
  let temp: TempStore
  let engine: StateEngine
  let connection: SqliteConnection
  let engineRestarts: number

  beforeEach(() => {
    resetMessageIds()
    engineRestarts = 0
    harness = createSupervisorHarness({
      preflight: passingPreflight(),
      restartDelayMs: RESTART_DELAY_MS,
      actions: {
        // Exactly what `main.ts` wires as the engine's restart action.
        engine: () => {
          engineRestarts += 1
          engine.stop()
          engine.start()
          return Promise.resolve()
        },
      },
    })
    temp = createTempStore({ clock: harness.clock })
    connection = productionConnection()
    engine = new StateEngine({
      store: temp.store,
      clock: harness.clock,
      config: testConfig(),
      inputConfig: testInputConfig(),
      publisher: new RecordingPublisher(),
      autoTick: false,
    })
  })

  afterEach(() => {
    freeDisk(connection)
    engine.stop()
    temp.dispose()
  })

  /** The renderer applying the read model: it acknowledges what it is sent. */
  function ackState(): void {
    engine.onAckState(engine.health().stateRevision, harness.clock.nowUtcIso())
  }

  /** Every open effect acknowledged, i.e. one §7.3(7) retransmit answered. */
  function ackEveryEffect(): string[] {
    const open = temp.store.listUnackedEffects().map((entry) => entry.effect.effectId)
    for (const effectId of open) engine.onAckEffect(effectId, harness.clock.nowUtcIso())
    return open.filter((effectId) => temp.store.getEffect(effectId)?.ackedAt == null)
  }

  function degradedFamilies(): string[] {
    return harness.supervisor
      .health()
      .families.filter((family) => family.status === 'degraded')
      .map((family) => family.family)
  }

  /** One evaluation cycle: the scheduled restart fires, then T12 reads health. */
  async function cycle(): Promise<void> {
    await harness.clock.advance(RESTART_DELAY_MS)
    engine.pump()
    ackState()
    harness.engine = engine.health()
    harness.pushHealthy()
    await harness.supervisor.evaluate()
    await flushMicrotasks()
  }

  /**
   * A live run whose world has nothing left to commit, with the file full and
   * every open effect's ACK refused.
   *
   * The world is drained first for the same reason as in the expiry test: a
   * pass that still owes a commit fails on a full disk, and a failed pass would
   * be a second, different fault in the same family. Drained, the writer keeps
   * completing its passes and the ACK path is the only thing broken.
   */
  async function liveWithRefusedAcks(): Promise<string[]> {
    engine.start()
    ackState()
    harness.engine = engine.health()
    harness.pushHealthy()
    await harness.supervisor.start()
    expect(harness.supervisor.state).toBe('live')

    await commitOpenEffects(engine, harness.clock)
    for (let pass = 0; pass < 40 && engine.runPending() > 0; pass += 1);

    fillDisk(connection)
    const refused = ackEveryEffect()
    expect(refused.length).toBeGreaterThan(0)
    return refused
  }

  it('spends the engine restart budget and then safe-stops (F-12 → F-18)', async () => {
    const refused = await liveWithRefusedAcks()

    const budget = harness.config.restart.maxAttempts['engine']
    const seenDegraded: string[][] = []
    for (let attempt = 0; attempt <= budget + 1; attempt += 1) {
      if (harness.supervisor.state === 'safe_stopped') break
      await cycle()
      // The renderer answers each retransmit, and the full file refuses each
      // ACK again: the condition is live for every one of these evaluations,
      // not a value left behind by the first one.
      ackEveryEffect()
      seenDegraded.push(degradedFamilies())
    }

    // Nothing else was wrong: the outstanding ACKs alone drove this.
    for (const families of seenDegraded.slice(0, -1)) expect(families).toEqual(['coordinator'])

    expect(engineRestarts).toBe(budget)
    expect(harness.supervisor.state).toBe('safe_stopped')
    const health = harness.supervisor.health()
    expect(health.safeStop?.kind).toBe('restart_budget_exhausted')
    expect(health.safeStop?.reason ?? '').toContain('engine')
    expect(
      harness.alerts.alerts.some(
        (alert) => alert.severity === 'critical' && alert.kind === 'supervisor.safe_stopped',
      ),
    ).toBe(true)

    // Why the restarts could not help: `engine.stop(); engine.start()` re-reads
    // the outbox, and rows it re-reads are still unacked because the file is
    // still full. A restart is not a repair for a store that will not write.
    // (A full file does take the ACKs that fit in free bytes it already has, so
    // the claim is that the condition outlived the restarts, not that no ACK of
    // the batch was ever recorded.)
    expect(
      refused.filter((id) => temp.store.getEffect(id)?.ackedAt == null).length,
    ).toBeGreaterThan(0)
    expect(engine.health().consecutiveFailures).toBeGreaterThan(0)
  }, 60_000)

  it('goes back to live when space and the ACK arrive before the budget is spent', async () => {
    const refused = await liveWithRefusedAcks()
    const budget = harness.config.restart.maxAttempts['engine']

    // Two evaluations: the supervisor is degraded and has started restarting.
    await cycle()
    ackEveryEffect()
    await cycle()
    expect(harness.supervisor.state).not.toBe('safe_stopped')
    expect(engineRestarts).toBeGreaterThan(0)
    expect(engineRestarts).toBeLessThan(budget)

    // The operator freed the space (spec §9.1) and the renderer's next ACK is
    // the one that finally records the row.
    freeDisk(connection)
    expect(ackEveryEffect()).toHaveLength(0)
    // Every refused row has its `acked_at` now, so the ACK half of the counter
    // is empty. What is left on it is the writer-pass streak from the passes the
    // full file failed, and a completed pass is what clears that half.
    expect(engine.health().openEffectCount).toBe(0)

    // One cycle for the supervisor to read the recovered engine, one more for a
    // restart that was already in flight to finish.
    await cycle()
    await cycle()
    expect(engine.health().consecutiveFailures).toBe(0)

    expect(harness.supervisor.state).toBe('live')
    expect(harness.supervisor.health().safeStop).toBeNull()
    const component = harness.supervisor.components().find((entry) => entry.component === 'engine')
    // The budget is returned, so the next unrelated fault gets its own three.
    expect(component?.attempts).toBe(0)
    expect(component?.exhausted).toBe(false)

    // And it stays live: no false-degraded left latched behind the recovery.
    const restartsAtRecovery = engineRestarts
    for (let idle = 0; idle < 4; idle += 1) await cycle()
    expect(harness.supervisor.state).toBe('live')
    expect(degradedFamilies()).toEqual([])
    expect(engineRestarts).toBe(restartsAtRecovery)
    expect(refused.filter((id) => temp.store.getEffect(id)?.ackedAt == null)).toHaveLength(0)
  }, 60_000)
})

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}
