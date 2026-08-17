import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IngestEnvelope } from '@vl/contract'

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
