import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IngestEnvelope } from '@vl/contract'

import { openDatabase } from '../db/open.js'
import { TEST_BUSY_TIMEOUT_MS } from '../db/testing/temp-store.js'
import { createServer } from '../server.js'
import { SimulatorIngestEndpoint, simulatorSourceKey } from './ingest.js'
import {
  at,
  commandEnvelope,
  createEngineHarness,
  resetMessageIds,
  type EngineHarness,
} from './testing/harness.js'

/**
 * `POST /ingest/simulator` (TASK_SPECS §T8, §T11 acceptance 3).
 *
 * The refusals are the subject: disabled is a 404 and not a 403, an off-loopback
 * caller never reaches the token check, and a body that fails the envelope schema
 * never reaches the inbox. No response echoes the body (spec §12.3).
 */

const TOKEN = 'test_simulator_token_0002'

describe('SimulatorIngestEndpoint', () => {
  let harness: EngineHarness
  let ingested: number[]

  beforeEach(() => {
    resetMessageIds()
    // The real engine is the inbox writer, so these tests exercise the production
    // funnel including its storage-boundary sanitizer.
    harness = createEngineHarness()
    ingested = []
  })

  afterEach(() => {
    harness.dispose()
  })

  function endpoint(enabled = true, token: string | null = TOKEN): SimulatorIngestEndpoint {
    return new SimulatorIngestEndpoint({
      inbox: harness.engine,
      enabled,
      token,
      onIngested: (count) => ingested.push(count),
    })
  }

  function request(body: unknown, overrides: Record<string, unknown> = {}) {
    return {
      authorization: `Bearer ${TOKEN}`,
      remoteAddress: '127.0.0.1',
      body,
      ...overrides,
    } as Parameters<SimulatorIngestEndpoint['handle']>[0]
  }

  function batch(envelopes: IngestEnvelope[]): unknown {
    return { envelopes }
  }

  it('accepts a batch and commits it to the inbox', () => {
    const response = endpoint().handle(
      request(batch([commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })])),
    )

    expect(response.status).toBe(202)
    expect(response.body).toMatchObject({ accepted: 1, inserted: 1, duplicates: 0 })
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(1)
    expect(ingested).toEqual([1])
  })

  it('reports a repeated envelope as a duplicate without a second row', () => {
    const envelope = commandEnvelope({
      messageId: 'msg_test_ing_dup',
      command: 'PET',
      receivedAt: at(1_000),
    })
    const api = endpoint()
    api.handle(request(batch([envelope])))

    const response = api.handle(request(batch([envelope])))

    expect(response.body).toMatchObject({ inserted: 0, duplicates: 1 })
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(1)
  })

  it('is a 404 while the simulator is disabled', () => {
    const response = endpoint(false).handle(
      request(batch([commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })])),
    )

    expect(response).toEqual({ status: 404, body: { error: 'not_found' } })
  })

  it('refuses a caller that is not on loopback before it checks the token', () => {
    const response = endpoint().handle(
      request(batch([commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })]), {
        remoteAddress: '10.0.0.5',
        authorization: null,
      }),
    )

    expect(response.status).toBe(403)
  })

  it('refuses a wrong, absent or unconfigured token', () => {
    const body = batch([commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })])

    expect(endpoint().handle(request(body, { authorization: null })).status).toBe(401)
    expect(endpoint().handle(request(body, { authorization: 'Bearer nope' })).status).toBe(401)
    expect(endpoint().handle(request(body, { authorization: TOKEN })).status).toBe(401)
    // No token configured is a closed door, not an open one.
    expect(endpoint(true, null).handle(request(body)).status).toBe(401)
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('refuses a body that is not a batch of envelopes', () => {
    const api = endpoint()

    expect(api.handle(request('nope')).status).toBe(400)
    expect(api.handle(request({ envelopes: [] })).status).toBe(400)
    expect(api.handle(request({ envelopes: [{ nope: true }] }))).toMatchObject({
      status: 400,
      body: { error: 'invalid_envelope', index: 0 },
    })
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('refuses an envelope that claims to be real participation (spec §2.6)', () => {
    const envelope = {
      ...commandEnvelope({ command: 'FEED', receivedAt: at(1_000) }),
      source: 'youtube',
      sourceShape: 'rest',
    }

    const response = endpoint().handle(request(batch([envelope as IngestEnvelope])))

    expect(response).toEqual({
      status: 400,
      body: { error: 'source_must_be_simulator', index: 0 },
    })
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('cannot touch a production source checkpoint', () => {
    // R-T8-1 major 1: an authenticated simulator request used to be able to name
    // any `sourceKey` and overwrite the live YouTube reconnect token with a
    // synthetic one, which loses real messages on the next reconnect.
    harness.store.commitIngestBatch([], {
      sourceKey: 'youtube:chat_live',
      liveChatId: 'chat_live',
      nextPageToken: 'token_real',
    })

    const response = endpoint().handle(
      request({
        envelopes: [commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })],
        checkpoint: {
          sourceKey: 'youtube:chat_live',
          liveChatId: 'chat_live',
          nextPageToken: 'token_simulator_overwrite',
        },
      }),
    )

    expect(response).toMatchObject({
      status: 400,
      body: { error: 'checkpoint_live_chat_id_must_match_the_batch' },
    })
    expect(harness.store.getSourceCheckpoint('youtube:chat_live')?.nextPageToken).toBe('token_real')
  })

  it('refuses a source key outside the simulator namespace', () => {
    const response = endpoint().handle(
      request({
        envelopes: [commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })],
        checkpoint: { sourceKey: 'youtube:chat_test_engine', liveChatId: 'chat_test_engine' },
      }),
    )

    expect(response).toMatchObject({
      status: 400,
      body: { error: 'checkpoint_source_key_must_be_the_simulator_namespace' },
    })
    expect(harness.store.getSourceCheckpoint('youtube:chat_test_engine')).toBeNull()
  })

  it('accepts the derived checkpoint restated by the caller', () => {
    const response = endpoint().handle(
      request({
        envelopes: [commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })],
        checkpoint: {
          sourceKey: simulatorSourceKey('chat_test_engine'),
          liveChatId: 'chat_test_engine',
          nextPageToken: 'token_sim_page_2',
        },
      }),
    )

    expect(response.status).toBe(202)
    expect(harness.store.getSourceCheckpoint('simulator:chat_test_engine')?.nextPageToken).toBe(
      'token_sim_page_2',
    )
  })

  it('refuses a batch that mixes live chats', () => {
    const response = endpoint().handle(
      request({
        envelopes: [
          commandEnvelope({ command: 'FEED', receivedAt: at(1_000) }),
          {
            ...commandEnvelope({ command: 'PET', receivedAt: at(1_100) }),
            liveChatId: 'chat_other',
          },
        ],
      }),
    )

    expect(response).toMatchObject({
      status: 400,
      body: { error: 'batch_must_share_one_live_chat_id' },
    })
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(0)
  })

  it('drops an argument outside the content vocabulary before it is stored', () => {
    const response = endpoint().handle(
      request(
        batch([
          commandEnvelope({ command: 'FEED', receivedAt: at(1_000), argument: 'not_a_choice' }),
        ]),
      ),
    )

    expect(response.status).toBe(202)
    const rows = harness.store.drainUnprocessed(0, 10)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0]?.envelope)).not.toContain('not_a_choice')
  })

  it('refuses a malformed checkpoint', () => {
    const response = endpoint().handle(
      request({
        envelopes: [commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })],
        checkpoint: { sourceKey: 42 },
      }),
    )

    expect(response.status).toBe(400)
  })

  it('defaults the checkpoint to the batch it just committed', () => {
    endpoint().handle(request(batch([commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })])))

    const checkpoint = harness.store.getSourceCheckpoint('simulator:chat_test_engine')
    expect(checkpoint?.lastIngestSeq).toBe(1)
    expect(checkpoint?.nextPageToken).toBeNull()
  })
})

/**
 * The rest of the write-failure vocabulary (T8b). `SQLITE_BUSY` is the one the
 * fault matrix drill hit and the one the HTTP tests below reproduce for real; the
 * others are classified by `db/errors.ts` from a code the store never reaches in
 * a test, so they are exercised through a stub writer.
 */
describe('SimulatorIngestEndpoint write failures', () => {
  function refusing(error: unknown): SimulatorIngestEndpoint {
    return new SimulatorIngestEndpoint({
      inbox: {
        ingest: () => {
          throw error
        },
      },
      enabled: true,
      token: TOKEN,
    })
  }

  function post(endpoint: SimulatorIngestEndpoint) {
    return endpoint.handle({
      authorization: `Bearer ${TOKEN}`,
      remoteAddress: '127.0.0.1',
      body: { envelopes: [commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })] },
    })
  }

  function sqliteError(code: string): Error {
    // Shaped like `better-sqlite3`'s `SqliteError`, whose `code` is the extended
    // result code name. https://sqlite.org/rescode.html (2026-08-18)
    return Object.assign(new Error(`disk I/O error at C:\\Users\\host\\data\\vertical-live.db`), {
      code,
    })
  }

  it('is a 503 only for lock contention, which the same request can survive', () => {
    expect(post(refusing(sqliteError('SQLITE_BUSY')))).toEqual({
      status: 503,
      body: { error: 'ingest_unavailable', reason: 'db_busy' },
    })
    expect(post(refusing(sqliteError('SQLITE_BUSY_SNAPSHOT')))).toMatchObject({ status: 503 })
    expect(post(refusing(sqliteError('SQLITE_LOCKED')))).toEqual({
      status: 503,
      body: { error: 'ingest_unavailable', reason: 'db_locked' },
    })
  })

  it('is a 500 for a failure that repeating the request cannot fix', () => {
    // Spec §11 names disk-full and DB corruption as their own fault matrix rows:
    // the supervisor (T12) acts on those, and the caller retrying does not.
    expect(post(refusing(sqliteError('SQLITE_FULL')))).toEqual({
      status: 500,
      body: { error: 'ingest_failed', reason: 'db_disk_full' },
    })
    expect(post(refusing(sqliteError('SQLITE_CORRUPT')))).toEqual({
      status: 500,
      body: { error: 'ingest_failed', reason: 'db_corrupt' },
    })
    expect(post(refusing(sqliteError('SQLITE_IOERR_WRITE')))).toEqual({
      status: 500,
      body: { error: 'ingest_failed', reason: 'db_io' },
    })
  })

  it('names no kind for an exception that did not come from SQLite', () => {
    expect(post(refusing(new Error('boom')))).toEqual({
      status: 500,
      body: { error: 'ingest_failed', reason: 'internal' },
    })
  })

  it('puts no part of the exception in the response', () => {
    for (const error of [sqliteError('SQLITE_FULL'), new Error(`token ${TOKEN} rejected`)]) {
      const body = JSON.stringify(post(refusing(error)).body)
      expect(body).not.toContain('vertical-live.db')
      expect(body).not.toContain('C:\\')
      expect(body).not.toContain(TOKEN)
      expect(body).not.toContain('SQLITE')
    }
  })
})

/**
 * A failed inbox write is an answer, not a hang (T8b, found by T15's fault matrix
 * drill of spec §11 "DB lock").
 *
 * SQLite has one writer, so a second connection holding the write lock makes
 * `commitIngestBatch` wait out `busy_timeout` and then throw `SQLITE_BUSY`. The
 * exception used to escape through `void readJsonBody(req).then(onFulfilled, …)`
 * in `server.ts`: the `onRejected` argument only covers the promise it is
 * attached to, so a throw *inside* `onFulfilled` rejected the promise `.then()`
 * returned — which nobody held. The response was never written and the caller
 * waited forever, while the process took an unhandled rejection.
 *
 * These tests are HTTP-level on purpose: the hang was a property of the
 * request/response pair, not of `handle()`'s return value.
 */
describe('POST /ingest/simulator when the inbox write fails', () => {
  let harness: EngineHarness
  let server: Server
  let baseUrl: string
  let blocker: ReturnType<typeof openDatabase> | null = null
  let failAfterCommit = false
  const leaked: unknown[] = []
  const recordLeak = (reason: unknown): void => {
    leaked.push(reason)
  }

  beforeEach(async () => {
    resetMessageIds()
    harness = createEngineHarness()
    leaked.length = 0
    failAfterCommit = false
    process.on('unhandledRejection', recordLeak)
    server = createServer({
      ingest: new SimulatorIngestEndpoint({
        inbox: harness.engine,
        enabled: true,
        token: TOKEN,
        onIngested: () => {
          if (failAfterCommit) throw new Error('post-commit failure the endpoint cannot classify')
        },
      }),
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterEach(async () => {
    process.off('unhandledRejection', recordLeak)
    if (blocker !== null) {
      blocker.exec('ROLLBACK')
      blocker.close()
      blocker = null
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    harness.dispose()
  })

  /** Takes the single write lock the way this store's transactions do. */
  function holdTheWriteLock(): void {
    blocker = openDatabase({ file: harness.temp.file, busyTimeoutMs: TEST_BUSY_TIMEOUT_MS })
    blocker.exec('BEGIN IMMEDIATE')
    blocker.prepare('INSERT INTO gift_combo (base_key, stored_max) VALUES (?, ?)').run('t8b', 1)
  }

  async function post(): Promise<Response | null> {
    try {
      return await fetch(`${baseUrl}/ingest/simulator`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          envelopes: [commandEnvelope({ command: 'FEED', receivedAt: at(1_000) })],
        }),
        // Turns the hang into a bounded failure instead of a stuck test run.
        signal: AbortSignal.timeout(2_000),
      })
    } catch {
      return null
    }
  }

  /** Lets a pending rejection reach `process`'s handler before we assert on it. */
  async function settle(): Promise<void> {
    for (let index = 0; index < 3; index += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
    }
  }

  it('answers 503 with a reason code while another connection holds the write lock', async () => {
    holdTheWriteLock()

    const response = await post()
    await settle()

    expect({
      answered: response !== null,
      status: response?.status ?? null,
      unhandledRejections: leaked.length,
    }).toEqual({ answered: true, status: 503, unhandledRejections: 0 })
    await expect(response?.json()).resolves.toEqual({
      error: 'ingest_unavailable',
      reason: 'db_busy',
    })
    // Nothing of the refused batch reached the inbox.
    expect(harness.store.drainUnprocessed(0, 10)).toEqual([])
  })

  it('says nothing about the exception itself (spec §12.3, §10.2)', async () => {
    holdTheWriteLock()

    const response = await post()
    const text = response === null ? '' : await response.text()

    // No message, no stack, no SQLite code, and above all no filesystem path:
    // `SqliteError` messages and the database file name are operator detail, not
    // something an endpoint hands back.
    expect(text).not.toContain('SQLITE')
    expect(text).not.toContain('vertical-live.db')
    expect(text).not.toContain(harness.temp.directory)
    expect(text).not.toContain(TOKEN)
  })

  it('ends the request even when the throw is not one the endpoint classifies', async () => {
    // The route maps what it can name; the HTTP layer's own net is what keeps
    // *anything else* from repeating the hang, so it is tested on its own.
    failAfterCommit = true

    const response = await post()
    await settle()

    expect({
      status: response?.status ?? null,
      unhandledRejections: leaked.length,
    }).toEqual({ status: 500, unhandledRejections: 0 })
    await expect(response?.json()).resolves.toEqual({ error: 'internal_error' })
  })

  it('still answers 202 once the lock is released', async () => {
    holdTheWriteLock()
    await post()
    blocker?.exec('ROLLBACK')
    blocker?.close()
    blocker = null

    const response = await post()
    await settle()

    expect(response?.status).toBe(202)
    expect(leaked).toEqual([])
    expect(harness.store.drainUnprocessed(0, 10)).toHaveLength(1)
  })
})
