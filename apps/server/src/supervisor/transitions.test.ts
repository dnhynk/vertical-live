import { describe, expect, it } from 'vitest'

import { componentsToRestart, nextSupervisorState, type TransitionInput } from './transitions.js'
import {
  HEALTH_FAMILIES,
  type FamilyVerdict,
  type HealthAggregate,
  type HealthFamily,
  type PreflightResult,
  type SafeStopTrigger,
  type SupervisorState,
} from './types.js'

/**
 * The transition table of spec §9.2 (TASK_SPECS §T12 acceptance 1), stated as a
 * table: one row per (state, signal combination) so a change to the rules has to
 * change a row rather than hide in a branch.
 */

function verdict(
  family: HealthFamily,
  status: FamilyVerdict['status'],
  reason?: string,
): FamilyVerdict {
  return {
    family,
    status,
    reason: reason ?? (status === 'ok' ? null : status),
    sources: [],
    observedAtUtc: '2026-01-01T00:00:00.000Z',
    unknownForMs: null,
    unobservableEscalated: false,
  }
}

function aggregate(degraded: Partial<Record<HealthFamily, string>> = {}): HealthAggregate {
  const families = {} as Record<HealthFamily, FamilyVerdict>
  const degradedFamilies: HealthFamily[] = []
  for (const family of HEALTH_FAMILIES) {
    const reason = degraded[family]
    if (reason === undefined) {
      families[family] = verdict(family, 'ok')
      continue
    }
    families[family] = verdict(family, 'degraded', reason)
    degradedFamilies.push(family)
  }
  return {
    atUtc: '2026-01-01T00:00:00.000Z',
    atMonotonicMs: 0,
    families,
    degradedFamilies,
    unknownFamilies: [],
    unmappedSignals: [],
    inputHealthy: degraded.chat_transport === undefined,
  }
}

const passedPreflight: PreflightResult = {
  passed: true,
  at: '2026-01-01T00:00:00.000Z',
  checks: [],
  failed: [],
  safeStop: null,
}

const failedPreflight: PreflightResult = {
  passed: false,
  at: '2026-01-01T00:00:00.000Z',
  checks: [],
  failed: ['encoder'],
  safeStop: null,
}

const policyStop: SafeStopTrigger = {
  kind: 'rights_or_policy',
  at: '2026-01-01T00:00:00.000Z',
  reason: 'broadcast_limit_unrecoverable',
  detail: {},
}

function input(overrides: Partial<TransitionInput> = {}): TransitionInput {
  return {
    aggregate: aggregate(),
    preflight: passedPreflight,
    recovering: false,
    safeStop: null,
    startRequested: true,
    ...overrides,
  }
}

describe('supervisor transition table (spec §9.2)', () => {
  const rows: readonly (readonly [string, SupervisorState, TransitionInput, SupervisorState])[] = [
    [
      'offline stays offline until start is requested',
      'offline',
      input({ startRequested: false }),
      'offline',
    ],
    ['offline → starting on start', 'offline', input({ startRequested: true }), 'starting'],
    ['starting waits for the pre-checks', 'starting', input({ preflight: null }), 'starting'],
    [
      'starting retries while a pre-check fails',
      'starting',
      input({ preflight: failedPreflight }),
      'starting',
    ],
    [
      'starting → live when the pre-checks pass and every family is ok',
      'starting',
      input(),
      'live',
    ],
    [
      'starting → degraded when the pre-checks pass but a family is not ok',
      'starting',
      input({ aggregate: aggregate({ obs_output: 'output_inactive' }) }),
      'degraded',
    ],
    ['live stays live while every family is ok', 'live', input(), 'live'],
    [
      'live → degraded when the input path is unhealthy',
      'live',
      input({ aggregate: aggregate({ chat_transport: 'retry_budget_exhausted' }) }),
      'degraded',
    ],
    [
      'live → recovering when a supervisor is already acting',
      'live',
      input({ aggregate: aggregate({ renderer: 'no_renderer' }), recovering: true }),
      'recovering',
    ],
    [
      'degraded → recovering once an attempt is in flight',
      'degraded',
      input({ aggregate: aggregate({ renderer: 'no_renderer' }), recovering: true }),
      'recovering',
    ],
    ['degraded → live on recovery', 'degraded', input(), 'live'],
    ['recovering → live on recovery', 'recovering', input(), 'live'],
    [
      'recovering → degraded when the attempt finished and it is still unhealthy',
      'recovering',
      input({ aggregate: aggregate({ obs_output: 'output_inactive' }) }),
      'degraded',
    ],
    [
      'live → safe_stopped on a policy trigger',
      'live',
      input({ safeStop: policyStop }),
      'safe_stopped',
    ],
    [
      'starting → safe_stopped on a policy trigger',
      'starting',
      input({ preflight: failedPreflight, safeStop: policyStop }),
      'safe_stopped',
    ],
  ]

  for (const [name, from, transitionInput, expected] of rows) {
    it(name, () => {
      expect(nextSupervisorState(from, transitionInput).to).toBe(expected)
    })
  }

  it('never leaves safe_stopped, even once every family is healthy again', () => {
    // Spec §9.1/§9.2: rights, policy and integrity stops are not restarted
    // automatically. Recovery of the signals is not consent to go back live.
    const transition = nextSupervisorState('safe_stopped', input({ safeStop: null }))

    expect(transition.to).toBe('safe_stopped')
    expect(transition.changed).toBe(false)
    expect(transition.reason).toBe('safe_stopped_is_terminal')
  })

  it('names the degraded families in the reason so /health can show why', () => {
    const transition = nextSupervisorState(
      'live',
      input({ aggregate: aggregate({ renderer: 'webgl_context_lost', frame_loss: 'congestion' }) }),
    )

    expect(transition.reason).toBe('degraded:renderer+frame_loss')
  })
})

describe('recovery plan (spec §10.2)', () => {
  it('maps each degraded family to the component that owns the fix', () => {
    expect(componentsToRestart(aggregate({ coordinator: 'writer_failing' }))).toEqual(['engine'])
    expect(componentsToRestart(aggregate({ state_commit: 'state_commit_stale' }))).toEqual([
      'engine',
    ])
    expect(componentsToRestart(aggregate({ renderer: 'no_renderer' }))).toEqual(['renderer-source'])
    expect(componentsToRestart(aggregate({ chat_transport: 'retry_budget_exhausted' }))).toEqual([
      'chat-source',
    ])
    expect(componentsToRestart(aggregate({ obs_output: 'output_inactive' }))).toEqual([
      'obs-stream',
    ])
  })

  it('treats an unreachable OBS as a connection problem, not an output one', () => {
    expect(
      componentsToRestart(aggregate({ obs_output: 'unobservable:obs_not_connected' })),
    ).toEqual(['obs-connection'])
  })

  it('restarts the encoder output when YouTube reports no ingest', () => {
    expect(componentsToRestart(aggregate({ youtube_broadcast: 'stream_inactive' }))).toEqual([
      'obs-stream',
    ])
  })

  it('asks for no restart where none would help', () => {
    // Congestion and skipped frames are load; the broadcast lifecycle belongs to
    // T10. Restarting the output for either would drop a stream that is still up.
    expect(componentsToRestart(aggregate({ frame_loss: 'congestion' }))).toEqual([])
    expect(componentsToRestart(aggregate({ youtube_broadcast: 'lifecycle_ready' }))).toEqual([])
    expect(componentsToRestart(aggregate({ dead_man: 'push_failed' }))).toEqual([])
  })

  it('lists a component once even when two families point at it', () => {
    expect(
      componentsToRestart(aggregate({ coordinator: 'writer_failing', state_commit: 'stale' })),
    ).toEqual(['engine'])
  })
})
