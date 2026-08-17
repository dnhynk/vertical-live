import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { CONTRACT_VERSION } from '@vl/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

import { createTempStore, type TempStore } from '../db/testing/temp-store.js'
import { createServer } from '../server.js'
import { FakeClock } from '../testing/fake-clock.js'
import { StateEngine } from './engine.js'
import { RendererHub } from './publisher.js'
import {
  at,
  createEngineHarness,
  ingest,
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
 */
async function commitOpenEffects(engine: StateEngine, clock: FakeClock): Promise<void> {
  for (let round = 0; round < PAID_EVENTS / PAID_EVENTS_PER_ROUND; round += 1) {
    const envelopes = []
    for (let index = 0; index < PAID_EVENTS_PER_ROUND; index += 1) {
      envelopes.push(superChatEnvelope({ receivedAt: at(1_000 + round * 1_000 + index) }))
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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}
