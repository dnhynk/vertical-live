import { fromGrpcStreamListItem, fromRestListItem, type IngestAdapterContext } from '@vl/contract'
import { loadSourceFixtures, type FixtureShape } from '@vl/contract/fixtures'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ACCEPTED_VECTORS, LEAK_MARKERS, REJECTED_VECTORS } from './fixtures/adversarial.js'
import { createCommandParserPort } from './index.js'
import { CommandMetrics } from './metrics.js'
import { parseMessage, type ParserLimits } from './parse.js'
import type { ParseContext } from './types.js'

const LIMITS: ParserLimits = { maxRawLength: 500 }
const GATE_CLOSED: ParseContext = { identityGateOpen: false, voteWindowOpen: false }

describe('adversarial vectors (TASK_SPECS §T6 acceptance 1)', () => {
  it.each(REJECTED_VECTORS.map((vector) => [vector.name, vector] as const))(
    'rejects %s',
    (_name, vector) => {
      const result = parseMessage(vector.text, GATE_CLOSED, LIMITS)
      expect(result.status).toBe('rejected')
      expect(result).toMatchObject({ reason: vector.reason })
    },
  )

  it('lets no crafted vector through', () => {
    const escaped = REJECTED_VECTORS.filter(
      (vector) => parseMessage(vector.text, GATE_CLOSED, LIMITS).status === 'accepted',
    )
    expect(escaped.map((vector) => vector.name)).toEqual([])
  })
})

describe('benign spellings still work (TASK_SPECS §T6 acceptance 1)', () => {
  it.each(ACCEPTED_VECTORS.map((vector) => [vector.name, vector] as const))(
    'accepts %s',
    (_name, vector) => {
      expect(parseMessage(vector.text, GATE_CLOSED, LIMITS)).toEqual({
        status: 'accepted',
        command: { name: vector.command, argument: vector.argument ?? null },
        commandLike: true,
      })
    },
  )
})

describe('repeated identical input is deterministic', () => {
  it('produces the same result for a flood of the same message', () => {
    const results = Array.from({ length: 200 }, () => parseMessage('ごはん', GATE_CLOSED, LIMITS))
    for (const result of results) {
      expect(result).toEqual(results[0])
    }
  })
})

describe('rejected text never leaves the parser (spec §7.3(1), §12.3)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps no fragment of the message in the return value', () => {
    for (const vector of REJECTED_VECTORS) {
      const serialized = JSON.stringify(parseMessage(vector.text, GATE_CLOSED, LIMITS))
      for (const marker of LEAK_MARKERS) {
        expect(serialized.includes(marker), `${vector.name} leaked ${marker}`).toBe(false)
      }
      // Nothing longer than a rejection code should be in there at all.
      expect(Object.keys(JSON.parse(serialized) as object).sort()).toEqual([
        'commandLike',
        'reason',
        'status',
      ])
    }
  })

  it('keeps no fragment of the message in the metrics snapshot', () => {
    const metrics = new CommandMetrics()
    for (const vector of REJECTED_VECTORS) {
      metrics.recordParse(parseMessage(vector.text, GATE_CLOSED, LIMITS))
    }
    const serialized = JSON.stringify(metrics.snapshot())
    for (const marker of LEAK_MARKERS) {
      expect(serialized.includes(marker)).toBe(false)
    }
  })

  it('writes nothing to any console or stream while rejecting', () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    ]
    for (const vector of REJECTED_VECTORS) {
      parseMessage(vector.text, GATE_CLOSED, LIMITS)
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
    }
  })
})

describe('T1 source fixtures through the contract adapters', () => {
  const context: IngestAdapterContext = {
    broadcastId: 'bc_test_0001',
    liveChatId: 'chat_test_0001',
    receivedAt: '2026-08-16T00:00:02.000Z',
    parseCommand: createCommandParserPort({
      context: () => GATE_CLOSED,
      limits: LIMITS,
    }),
  }

  const adapt = (shape: FixtureShape, item: unknown) =>
    shape === 'grpc' ? fromGrpcStreamListItem(item, context) : fromRestListItem(item, context)

  it.each(['grpc', 'rest'] as const)('parses the plain %s alias fixture into FEED', (shape) => {
    const fixture = loadSourceFixtures(shape).find((entry) => entry.name === 'text-message-event')
    expect(fixture).toBeDefined()
    const envelope = adapt(shape, fixture?.item)
    expect(envelope).toMatchObject({ validationStatus: 'valid', command: { name: 'FEED' } })
  })

  it.each(['grpc', 'rest'] as const)(
    'refuses the %s noise fixture (full width command + link + banned word)',
    (shape) => {
      const fixture = loadSourceFixtures(shape).find(
        (entry) => entry.name === 'text-message-event-noise',
      )
      expect(fixture).toBeDefined()
      const envelope = adapt(shape, fixture?.item)
      expect(envelope).toMatchObject({ validationStatus: 'valid', command: null })
    },
  )

  it.each(['grpc', 'rest'] as const)('keeps no message text in any %s envelope', (shape) => {
    for (const fixture of loadSourceFixtures(shape)) {
      const serialized = JSON.stringify(adapt(shape, fixture.item))
      expect(serialized.includes('example.invalid'), fixture.name).toBe(false)
      expect(serialized.includes('NGWORD_TEST'), fixture.name).toBe(false)
      expect(serialized.includes('SYNTHETIC AUTHOR'), fixture.name).toBe(false)
    }
  })
})
