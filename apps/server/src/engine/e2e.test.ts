import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { CONTRACT_VERSION, type IngestEnvelope } from '@vl/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { systemClock } from '../clock.js'
import { createTempStore, type TempStore } from '../db/testing/temp-store.js'
import { createServer } from '../server.js'
import { StateEngine } from './engine.js'
import { SimulatorIngestEndpoint } from './ingest.js'
import { RendererHub } from './publisher.js'
import {
  TEST_BROADCAST_ID,
  TEST_LIVE_CHAT_ID,
  testEngineConfig,
  testInputConfig,
} from './testing/harness.js'

/**
 * End-to-end over the real surfaces: `POST /ingest/simulator` → writer loop →
 * `/ws/renderer` → ACK → `/metrics`.
 *
 * This is where the §7.5 numbers come from. The clock is the system clock on
 * purpose — the four legs of spec §7.3(8) are wall-clock latencies, and a fake
 * clock would report zeros that mean nothing. Nothing here asserts a pass line:
 * spec §7.5 locks the p95 threshold only after the Gate 2 calibration
 * (BOARD A-15), so the test asserts that the measurement exists and is sane, and
 * the numbers are recorded in the ticket.
 */

const SIMULATOR_TOKEN = 'test_simulator_token_0001'
const EVENT_COUNT = 20

describe('engine end to end', () => {
  let temp: TempStore
  let server: Server
  let hub: RendererHub
  let engine: StateEngine
  let baseUrl: string

  beforeEach(async () => {
    temp = createTempStore({ clock: systemClock })
    const config = testEngineConfig()
    const ingest = new SimulatorIngestEndpoint({
      store: temp.store,
      enabled: true,
      token: SIMULATOR_TOKEN,
      onIngested: () => {
        engine.notifyIngest()
        engine.runPending()
      },
    })
    server = createServer({
      engine: { health: () => engine.health(), metrics: () => engine.metrics() },
      ingest,
      rendererHealth: () => hub.lastHealth,
    })
    hub = new RendererHub({
      server,
      clock: systemClock,
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
      clock: systemClock,
      config: {
        ...config,
        engine: { ...config.engine, tickIntervalMs: 25 },
      },
      inputConfig: testInputConfig(),
      publisher: hub,
      autoTick: false,
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    engine.stop()
    hub.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    temp.dispose()
  })

  it('carries a simulator batch to the renderer and measures every leg', async () => {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/renderer`)
    const ackedEffects = new Set<string>()
    let ackedRevisions = 0

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; [key: string]: unknown }
      if (message['type'] === 'snapshot') {
        const snapshot = message['snapshot'] as { stateRevision: number }
        ackedRevisions += 1
        socket.send(
          JSON.stringify({
            schemaVersion: CONTRACT_VERSION,
            type: 'ack_state',
            stateRevision: snapshot.stateRevision,
            appliedAt: new Date().toISOString(),
          }),
        )
        return
      }
      if (message['type'] === 'effect') {
        const effect = message['effect'] as { effectId: string }
        if (ackedEffects.has(effect.effectId)) return
        ackedEffects.add(effect.effectId)
        socket.send(
          JSON.stringify({
            schemaVersion: CONTRACT_VERSION,
            type: 'ack_effect',
            effectId: effect.effectId,
            appliedAt: new Date().toISOString(),
          }),
        )
      }
    })
    socket.send(
      JSON.stringify({
        schemaVersion: CONTRACT_VERSION,
        type: 'hello',
        rendererId: 'renderer_test_0001',
        lastAppliedStateRevision: null,
      }),
    )
    await waitFor(() => hub.rendererCount === 1)

    engine.start()

    for (let index = 0; index < EVENT_COUNT; index += 1) {
      const response = await fetch(`${baseUrl}/ingest/simulator`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SIMULATOR_TOKEN}`,
        },
        body: JSON.stringify({ envelopes: [commandBatchEnvelope(index)] }),
      })
      expect(response.status).toBe(202)
      // One command per pass: the direct path is what the p95 is measured over.
      await sleep(5)
      engine.runPending()
    }

    await waitFor(() => ackedRevisions > 0 && ackedEffects.size >= EVENT_COUNT, 5_000)
    engine.runPending()
    await sleep(50)

    const metrics = (await (await fetch(`${baseUrl}/metrics`)).json()) as {
      latencyMs: Record<string, { count: number; p50Ms: number | null; p95Ms: number | null }>
      counters: Record<string, number>
    }
    process.stdout.write(
      `engine latency (local, ${String(EVENT_COUNT)} events): ${JSON.stringify(metrics.latencyMs)}\n`,
    )

    expect(metrics.latencyMs['receivedToCommitted']?.count).toBeGreaterThan(0)
    expect(metrics.latencyMs['committedToPublished']?.count).toBeGreaterThan(0)
    expect(metrics.latencyMs['publishedToAcked']?.count).toBeGreaterThan(0)
    expect(metrics.latencyMs['receivedToAcked']?.count).toBeGreaterThan(0)
    for (const leg of Object.values(metrics.latencyMs)) {
      expect(leg.p95Ms).not.toBeNull()
      expect(leg.p95Ms as number).toBeGreaterThanOrEqual(0)
    }
    expect(metrics.counters['commit']).toBeGreaterThan(0)

    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      status: string
      engine: { ready: boolean; rendererCount: number; interactionEnabled: boolean }
    }
    expect(health.engine.ready).toBe(true)
    expect(health.engine.rendererCount).toBe(1)
    expect(health.engine.interactionEnabled).toBe(true)

    socket.close()
  }, 30_000)

  it('rejects a renderer frame that is not in the contract', async () => {
    engine.start()
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/renderer`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })

    socket.send(JSON.stringify({ type: 'ack_state', stateRevision: -1 }))
    socket.send('not json at all')
    await sleep(50)

    // The frames are dropped; the connection and the engine stay healthy.
    expect(hub.rendererCount).toBe(1)
    expect(engine.health().lastAckedStateRevision).toBe(0)
    socket.close()
  }, 15_000)
})

function commandBatchEnvelope(index: number): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'simulator',
    source: 'simulator',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt: new Date().toISOString(),
    messageId: `msg_test_e2e_${String(index).padStart(4, '0')}`,
    validationStatus: 'valid',
    kind: 'CHAT_COMMAND',
    occurredAt: new Date().toISOString(),
    command: { name: 'FEED', argument: null },
    payment: null,
  }
}

async function sleep(millis: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, millis))
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await sleep(10)
  }
}
