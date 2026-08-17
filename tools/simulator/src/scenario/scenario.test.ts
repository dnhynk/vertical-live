import { IngestEnvelopeSchema } from '@vl/contract'
import { describe, expect, it } from 'vitest'

import { BUILTIN_SCENARIOS, findBuiltinScenario } from './catalog.js'
import { planScenario, requiresParser, scenarioIdentity } from './build.js'
import { ScenarioError, parseScenario } from './schema.js'

/**
 * The browser-safe half of the simulator: scenario validation and envelope
 * assembly. Everything here runs in the `?mode=dev` panel too, so the tests are
 * about the contract (spec §7.3(1), §2.6) rather than about a running server.
 */

const minimal = {
  id: 'unit-test',
  title: 'Unit test',
  summary: 'A one-step scenario used by the schema tests.',
  steps: [{ kind: 'command' as const, atMs: 0, command: 'FEED' as const }],
}

describe('parseScenario', () => {
  it('applies the defaults a scenario file may omit', () => {
    const scenario = parseScenario(minimal)

    expect(scenario.requiresVirtualClock).toBe(false)
    expect(scenario.steps[0]).toMatchObject({ argument: null, count: 1 })
  })

  it('refuses an unknown step kind instead of skipping it', () => {
    expect(() =>
      parseScenario({ ...minimal, steps: [{ kind: 'summon-dragon', atMs: 0 }] }),
    ).toThrow(ScenarioError)
  })

  it('refuses an unknown field rather than ignoring a typo', () => {
    expect(() => parseScenario({ ...minimal, stpes: [] })).toThrow(ScenarioError)
  })

  it('refuses a message id that could pass for a platform id (spec §2.6)', () => {
    expect(() =>
      parseScenario({
        ...minimal,
        steps: [{ kind: 'command', atMs: 0, command: 'FEED', messageId: 'LCC.xyz-real-looking' }],
      }),
    ).toThrow(ScenarioError)
  })

  it('refuses a negative offset', () => {
    expect(() =>
      parseScenario({ ...minimal, steps: [{ kind: 'command', atMs: -1, command: 'FEED' }] }),
    ).toThrow(ScenarioError)
  })
})

describe('planScenario', () => {
  it('stamps every envelope with the instant the runner supplies', () => {
    const plan = planScenario(parseScenario(minimal))
    const first = plan.batches[0]
    if (first === undefined) throw new Error('expected a batch')

    const early = first.build('2026-08-16T00:00:00.000Z')
    const late = first.build('2026-08-16T01:00:00.000Z')

    expect(early[0]?.receivedAt).toBe('2026-08-16T00:00:00.000Z')
    expect(late[0]?.receivedAt).toBe('2026-08-16T01:00:00.000Z')
    // The ids are assigned at plan time, so a replay is identical.
    expect(early[0]?.messageId).toBe(late[0]?.messageId)
  })

  it('derives obviously synthetic broadcast and chat ids (spec §2.6)', () => {
    const scenario = parseScenario(minimal)

    expect(scenarioIdentity(scenario)).toEqual({
      broadcastId: 'brd_sim_unit_test',
      liveChatId: 'chat_sim_unit_test',
    })
  })

  it('refuses to build a chat step without a parser (spec §7.3(1))', () => {
    const scenario = parseScenario({
      ...minimal,
      steps: [{ kind: 'chat', atMs: 0, text: 'feed' }],
    })

    expect(requiresParser(scenario)).toBe(true)
    expect(() => planScenario(scenario)).toThrow(/needs a command parser/)
  })

  it('carries only the parser verdict into a chat envelope, never the text', () => {
    const scenario = parseScenario({
      ...minimal,
      steps: [
        { kind: 'chat', atMs: 0, text: 'feed https://example.invalid/spam' },
        { kind: 'chat', atMs: 10, text: 'feed' },
      ],
    })
    const plan = planScenario(scenario, {
      // A stand-in for T6's parser: the real one is exercised in
      // `replay/moderation-bypass.test.ts`.
      parseCommand: (raw) => (raw === 'feed' ? { name: 'FEED', argument: null } : null),
    })

    const rejected = plan.batches[0]?.build('2026-08-16T00:00:00.000Z')[0]
    const accepted = plan.batches[1]?.build('2026-08-16T00:00:00.010Z')[0]

    expect(rejected?.validationStatus).toBe('valid')
    expect(rejected).toMatchObject({ kind: 'CHAT_COMMAND', command: null })
    expect(JSON.stringify(rejected)).not.toContain('example.invalid')
    expect(accepted).toMatchObject({ command: { name: 'FEED', argument: null } })
  })

  it('counts a trailing wait towards the end of the run', () => {
    const plan = planScenario(
      parseScenario({
        ...minimal,
        steps: [
          { kind: 'command', atMs: 0, command: 'FEED' },
          { kind: 'wait', atMs: 1_000, durationMs: 5_000 },
        ],
      }),
    )

    expect(plan.endsAtMs).toBe(6_000)
    expect(plan.envelopeCount).toBe(1)
  })

  it('repeats a step with fresh ids but keeps an explicit id for the first', () => {
    const plan = planScenario(
      parseScenario({
        ...minimal,
        steps: [
          { kind: 'command', atMs: 0, command: 'FEED', count: 3, messageId: 'msg_sim_explicit' },
        ],
      }),
    )
    const ids = plan.batches[0]?.build('2026-08-16T00:00:00.000Z').map((e) => e.messageId)

    expect(ids?.[0]).toBe('msg_sim_explicit')
    expect(new Set(ids).size).toBe(3)
  })
})

describe('BUILTIN_SCENARIOS', () => {
  it('covers every scenario TASK_SPECS §T11 names', () => {
    expect(BUILTIN_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'idle-24h',
      'direct-low',
      'aggregate-switch',
      'flood',
      'paid-replay',
      'degraded-window',
    ])
  })

  it('builds valid envelopes for every scenario the panel can run', () => {
    for (const scenario of BUILTIN_SCENARIOS) {
      expect(requiresParser(scenario)).toBe(false)
      const plan = planScenario(scenario)
      for (const batch of plan.batches) {
        for (const envelope of batch.build('2026-08-16T00:00:00.000Z')) {
          expect(IngestEnvelopeSchema.safeParse(envelope).success).toBe(true)
          expect(envelope.source).toBe('simulator')
          expect(envelope.messageId?.startsWith('msg_sim_')).toBe(true)
        }
      }
    }
  })

  it('returns null for an unknown id rather than a default scenario', () => {
    expect(findBuiltinScenario('no-such-scenario')).toBeNull()
  })
})
