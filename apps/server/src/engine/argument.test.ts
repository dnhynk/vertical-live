import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase } from '../db/open.js'
import { STORABLE_COMMAND_ARGUMENTS, sanitizeEnvelopeArgument } from './argument.js'
import {
  at,
  commandEnvelope,
  createEngineHarness,
  ingest,
  resetMessageIds,
  type EngineHarness,
} from './testing/harness.js'

/**
 * `command.argument` handling (TASK_SPECS §T8, R-T8-1 blocker 4).
 *
 * Two claims, each checked against the database rather than against a metric:
 *
 * 1. a token outside the content's whole choice vocabulary is **not stored** —
 *    `ingest_inbox.envelope_json` must not contain it;
 * 2. a token that is storable but that the *currently open* window does not
 *    expect is dropped from the world with a **reason in the processing record**,
 *    not silently recorded as `applied`.
 */

interface InboxObservation {
  readonly ingest_seq: number
  readonly processing_result: string | null
  readonly envelope_json: string
}

describe('command argument handling', () => {
  let harness: EngineHarness

  beforeEach(() => {
    resetMessageIds()
    harness = createEngineHarness()
  })

  afterEach(() => {
    harness.dispose()
  })

  /** Reads the inbox with a second connection, as an operator would. */
  function inbox(): InboxObservation[] {
    const database = openDatabase({ file: harness.temp.file, busyTimeoutMs: 250 })
    try {
      return database
        .prepare(
          'SELECT ingest_seq, processing_result, envelope_json FROM ingest_inbox ORDER BY ingest_seq',
        )
        .all() as InboxObservation[]
    } finally {
      database.close()
    }
  }

  it('never writes a token the content could not ask for', async () => {
    harness.engine.start()
    ingest(harness.engine, [
      commandEnvelope({
        messageId: 'msg_test_arg_bad',
        command: 'FEED',
        receivedAt: at(1_000),
        argument: 'not_a_choice',
      }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    const rows = inbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.envelope_json).not.toContain('not_a_choice')
    expect(JSON.parse(rows[0]?.envelope_json as string)).toMatchObject({
      command: { name: 'FEED', argument: null },
    })
    // The command itself still applied: only its argument was refused.
    expect(rows[0]?.processing_result).toBe('applied')
    expect(harness.engine.metrics().counters['ingest_argument_dropped']).toBe(1)
  })

  it('records a reason when the open window does not expect a storable token', async () => {
    const storable = [...STORABLE_COMMAND_ARGUMENTS][0] as string
    harness.engine.start()
    ingest(harness.engine, [
      commandEnvelope({
        messageId: 'msg_test_arg_closed',
        command: 'FEED',
        receivedAt: at(1_000),
        argument: storable,
      }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    const rows = inbox()
    expect(rows).toHaveLength(1)
    // Storable, so it is in the row …
    expect(JSON.parse(rows[0]?.envelope_json as string)).toMatchObject({
      command: { name: 'FEED', argument: storable },
    })
    // … and the record says both what happened and why the argument was refused.
    expect(rows[0]?.processing_result).toBe('applied:argument_rejected')
    expect(harness.engine.metrics().counters['command_argument_rejected']).toBe(1)
    expect(JSON.stringify(harness.publisher.effects)).not.toContain(storable)
  })

  it('leaves an argument alone when there is nothing to reject', async () => {
    harness.engine.start()
    ingest(harness.engine, [
      commandEnvelope({ messageId: 'msg_test_arg_none', command: 'PET', receivedAt: at(1_000) }),
    ])
    await harness.clock.advance(1_000)
    harness.engine.runPending()

    expect(inbox()[0]?.processing_result).toBe('applied')
    expect(harness.engine.metrics().counters['ingest_argument_dropped']).toBeUndefined()
    expect(harness.engine.metrics().counters['command_argument_rejected']).toBeUndefined()
  })
})

describe('sanitizeEnvelopeArgument', () => {
  it('keeps every choice id the content can offer', () => {
    expect(STORABLE_COMMAND_ARGUMENTS.size).toBeGreaterThan(0)
    for (const choiceId of STORABLE_COMMAND_ARGUMENTS) {
      const envelope = commandEnvelope({
        command: 'VOTE_A',
        receivedAt: at(0),
        argument: choiceId,
      })
      expect(sanitizeEnvelopeArgument(envelope)).toEqual({ envelope, dropped: false })
    }
  })

  it('drops anything else and leaves the rest of the envelope untouched', () => {
    const envelope = commandEnvelope({
      command: 'FEED',
      receivedAt: at(0),
      argument: 'zzz_unknown',
    })
    const sanitized = sanitizeEnvelopeArgument(envelope)

    expect(sanitized.dropped).toBe(true)
    expect(sanitized.envelope).toEqual({ ...envelope, command: { name: 'FEED', argument: null } })
  })

  it('passes a rejected envelope through unchanged', () => {
    const envelope = commandEnvelope({ command: 'FEED', receivedAt: at(0) })
    const rejected = { ...envelope, validationStatus: 'invalid' as const }

    expect(sanitizeEnvelopeArgument(rejected as never).dropped).toBe(false)
  })
})
