import { classifyOAuthErrorBody, classifySqliteError, classifyYouTubeApiError } from '@vl/server'
import { classifyStoreFailure } from '@vl/server/supervisor'
import { afterEach, describe, expect, it } from 'vitest'

import { captureDiskFullError, WriteLockHolder } from '../injection/storage.js'
import type { SoakSystem } from '../system.js'
import { FAULT_MATRIX, requireFaultRow, type FaultMatrixRow } from './rows.js'
import { SLICE_MS, startLive, tick, tickUntil } from './support.js'

/**
 * Fault matrix drills (TASK_SPECS §T15 합격 기준 1: "matrix 모든 행이 자동
 * 테스트로 존재하고 예상 상태와 일치").
 *
 * Each drill injects one row's fault into a **real** supervised system — the
 * real aggregator, the real §9.2 transition table, the real restart supervisors,
 * the real engine and the real SQLite store — and compares what happens with the
 * row's fixed `expected` / `expectedState`. Where the product owns a classifier,
 * the drill first asserts that the classifier and the row agree, so the number
 * being checked is never one this file invented.
 *
 * The four crash windows are in `crash-windows.test.ts`: they need an engine
 * taken to an exact commit boundary and then rebuilt, not a running broadcast.
 */

const covered = new Set<string>()

function drill(id: string): FaultMatrixRow {
  covered.add(id)
  return requireFaultRow(id)
}

let system: SoakSystem | undefined

afterEach(async () => {
  await system?.close()
  system = undefined
})

const live = (system: SoakSystem): boolean => system.supervisor.state === 'live'
const notLive = (system: SoakSystem): boolean => system.supervisor.state !== 'live'
const stopped = (system: SoakSystem): boolean => system.supervisor.state === 'safe_stopped'

describe('F-01 OAuth access-token 만료', () => {
  it('refreshes under the supervisor and never leaves live', async () => {
    const row = drill('F-01')
    const drillSystem = await startLive()
    system = drillSystem.system

    const first = await system.auth.forceRefresh()
    const second = await system.auth.forceRefresh()
    await tick(system, 2)

    expect(first.revoked).toBe(false)
    expect(second.revoked).toBe(false)
    // The fake endpoint serialises the access token, so a genuinely new token
    // proves the refresh happened rather than the cache being handed back.
    expect(second.token).not.toBe(first.token)
    expect(system.auth.tokens.state).toBe('ready')
    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.supervisor.aggregate?.degradedFamilies).toEqual([])
    // Data preservation: nothing about the world moved because of the refresh.
    expect(system.observe().consecutiveWriterFailures).toBe(0)
  })
})

describe('F-02 OAuth refresh-token 철회', () => {
  it('latches revoked, emits auth_revoked and stops the run', async () => {
    const row = drill('F-02')
    expect(classifyOAuthErrorBody({ error: 'invalid_grant' }, 400).faultAction).toBe(row.expected)

    const drillSystem = await startLive()
    system = drillSystem.system
    const beforeRevision = system.observe().stateRevision
    const beforeProcessed = system.observe().processedIngestSeq

    system.auth.revokeRefreshToken()
    const result = await system.auth.forceRefresh()
    await tick(system, 1)

    expect(result.revoked).toBe(true)
    expect(system.auth.events.some((event) => event.type === 'auth_revoked')).toBe(true)
    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.supervisor.health().safeStop?.kind).toBe('account_action')
    expect(system.alerts.ofKind('supervisor.safe_stopped')).toHaveLength(1)
    // Data preservation: what is on disk is exactly what the engine reports, and
    // nothing was rolled back by the stop.
    expect(system.store.loadRecoveryState().stateRevision).toBe(system.observe().stateRevision)
    expect(system.observe().stateRevision).toBeGreaterThanOrEqual(beforeRevision)
    expect(system.observe().processedIngestSeq).toBe(beforeProcessed)
  })
})

describe('F-03 YouTube API 403', () => {
  it('stops the run instead of retrying a call that is not allowed', async () => {
    const row = drill('F-03')
    expect(
      classifyYouTubeApiError({
        httpStatus: 403,
        body: { error: { errors: [{ reason: 'insufficientLivePermissions' }] } },
      }).action,
    ).toBe(row.expected)

    const drillSystem = await startLive()
    system = drillSystem.system
    const beforeRevision = system.observe().stateRevision

    system.broadcast.fail({ httpStatus: 403, reason: 'insufficientLivePermissions', calls: null })
    await tickUntil(system, stopped, 'safe stop after 403')

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.supervisor.health().safeStop?.kind).toBe('rights_or_policy')
    expect(system.store.loadRecoveryState().stateRevision).toBeGreaterThanOrEqual(beforeRevision)
  })
})

describe('F-04 YouTube API 429', () => {
  it('degrades while rate limited and returns to live on its own', async () => {
    const row = drill('F-04')
    expect(
      classifyYouTubeApiError({
        httpStatus: 429,
        body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
      }).action,
    ).toBe(row.expected)

    const drillSystem = await startLive()
    system = drillSystem.system
    await system.inject(2)

    system.chat.fail({ httpStatus: 429, reason: 'rateLimitExceeded', polls: 3 })
    await tickUntil(system, notLive, 'degrade under rate limiting')
    await tickUntil(system, live, 'automatic recovery from rate limiting')

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.chat.lastClassification?.kind).toBe('rateLimitExceeded')
    // 유실 0: everything accepted before the fault is still accounted for.
    expect(system.observe().processedIngestSeq).toBe(2)
  })
})

describe('F-05 YouTube quota 고갈', () => {
  it('degrades, keeps the world running and does not stop itself', async () => {
    const row = drill('F-05')
    expect(
      classifyYouTubeApiError({
        httpStatus: 403,
        body: { error: { errors: [{ reason: 'quotaExceeded' }] } },
      }).action,
    ).toBe(row.expected)

    const drillSystem = await startLive()
    system = drillSystem.system
    await system.inject(2)
    const beforeRevision = system.observe().stateRevision

    system.chat.fail({ httpStatus: 403, reason: 'quotaExceeded', polls: null })
    await tickUntil(system, notLive, 'degrade on quota exhaustion')

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.supervisor.health().safeStop).toBeNull()
    // §12.3/§9.2: the CTA goes off before anything else when input is unhealthy.
    expect(system.supervisor.health().interactionEnabled).toBe(false)
    // §2.1: content and state keep advancing with no input at all.
    await tick(system, 20)
    expect(system.observe().stateRevision).toBeGreaterThan(beforeRevision)
    expect(system.observe().processedIngestSeq).toBe(2)
  })
})

describe('F-06 DNS 단절', () => {
  it('retries the transport and recovers without a human', async () => {
    const row = drill('F-06')
    expect(classifyYouTubeApiError({ errorCode: 'ENOTFOUND' }).action).toBe(row.expected)

    const drillSystem = await startLive()
    system = drillSystem.system
    await system.inject(2)

    system.chat.fail({ errorCode: 'ENOTFOUND', polls: 3 })
    await tickUntil(system, notLive, 'degrade on DNS failure')
    await tickUntil(system, live, 'automatic recovery from DNS failure')

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.chat.lastClassification?.kind).toBe('network')
    expect(system.observe().processedIngestSeq).toBe(2)
  })
})

describe('F-07 RTMPS 단절', () => {
  it('restarts the output and returns to live, leaving world state untouched', async () => {
    const row = drill('F-07')
    const drillSystem = await startLive()
    system = drillSystem.system
    await system.inject(2)
    const beforeProcessed = system.observe().processedIngestSeq

    system.obs.cutRtmps()
    await tickUntil(system, notLive, 'degrade on an RTMPS cut')
    expect(system.supervisor.aggregate?.degradedFamilies).toContain('obs_output')

    await tickUntil(system, live, 'automatic recovery of the output')

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.obs.restarts.stream).toBeGreaterThan(0)
    expect(system.observe().processedIngestSeq).toBe(beforeProcessed)
  })
})

describe('F-08 OBS process crash (재기동 가능)', () => {
  it('escalates the connection to the process and recovers', async () => {
    const row = drill('F-08')
    const drillSystem = await startLive({ obsRelauncher: true })
    system = drillSystem.system

    system.obs.crashProcess()
    await tickUntil(system, notLive, 'degrade when OBS cannot be observed')
    await tickUntil(system, live, 'automatic recovery through the OBS relaunch', 90)

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.obs.restarts.process).toBeGreaterThan(0)
    expect(system.supervisor.health().safeStop).toBeNull()
  })
})

describe('F-09 OBS process crash (재기동 미배선)', () => {
  it('spends the escalation budget and stops safely', async () => {
    const row = drill('F-09')
    const drillSystem = await startLive({ obsRelauncher: false })
    system = drillSystem.system

    system.obs.crashProcess()
    await tickUntil(system, stopped, 'safe stop after the escalation budget', 120)

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.supervisor.health().safeStop?.kind).toBe('restart_budget_exhausted')
    expect(system.alerts.ofKind('supervisor.safe_stopped')).toHaveLength(1)
  })
})

describe('F-10 host crash', () => {
  it('recovers committed state and drains inbox rows the cursor had not passed', async () => {
    const row = drill('F-10')
    const drillSystem = await startLive()
    system = drillSystem.system

    await system.inject(3)
    await tick(system, 1)
    const processedBeforeCrash = system.observe().processedIngestSeq
    const revisionBeforeCrash = system.observe().stateRevision
    expect(processedBeforeCrash).toBe(3)

    // Two rows committed to the inbox but deliberately not drained: this is the
    // state the crash has to happen in for the recovery cursor to mean anything.
    system.pumpAfterIngest = false
    await system.inject(2)
    expect(system.observe().processedIngestSeq).toBe(3)
    system.pumpAfterIngest = true

    await system.crashHost()
    await tickUntil(system, live, 'recovery after a host crash', 90)
    // Two passes: the recovery drain hands the commands to the §6.4 arbiter, and
    // the window they land in closes on the next pass (spec §7.3(3)).
    await tick(system, 2)

    // The uncommitted DELETE the child held open never happened: had it landed,
    // the inbox would be empty and the cursor would have nothing to drain.
    expect(system.observe().processedIngestSeq).toBe(5)
    expect(system.observe().stateRevision).toBeGreaterThanOrEqual(revisionBeforeCrash)
    expect(system.supervisor.state).toBe(row.expectedState)
  })
})

describe('F-11 DB lock', () => {
  it('is a retryable SQLITE_BUSY that the writer survives', async () => {
    const row = drill('F-11')
    const drillSystem = await startLive()
    system = drillSystem.system

    // The classifier claim of the row, proved with a lock this test really takes.
    const holder = WriteLockHolder.open(system.file, 100)
    const contender = WriteLockHolder.open(system.file, 100)
    try {
      holder.acquire()
      let captured: unknown
      try {
        contender.acquire()
      } catch (error) {
        captured = error
      }
      expect(classifySqliteError(captured).kind).toBe('busy')
      expect(classifySqliteError(captured).retryable).toBe(true)
    } finally {
      contender.close()
      holder.close()
    }

    const beforeRevision = system.observe().stateRevision
    system.holdWriteLock()
    await tickUntil(
      system,
      (candidate) => candidate.observe().consecutiveWriterFailures > 0,
      'a writer pass blocked by the lock',
      90,
    )
    expect(system.engine.health().lastFailure?.error ?? '').toMatch(
      /database is locked|SQLITE_BUSY/i,
    )
    system.releaseWriteLock()

    await tickUntil(system, live, 'automatic recovery once the lock is released', 90)

    expect(system.supervisor.state).toBe(row.expectedState)
    // 부분 commit 없음: the persisted revision is the one the engine reports.
    expect(system.store.loadRecoveryState().stateRevision).toBe(system.observe().stateRevision)
    expect(system.observe().stateRevision).toBeGreaterThanOrEqual(beforeRevision)
  })
})

describe('F-12 disk-full', () => {
  it('is an operational failure, not a data-integrity stop', async () => {
    const row = drill('F-12')
    const diskFull = captureDiskFullError()
    expect(classifySqliteError(diskFull).kind).toBe('disk_full')
    expect(classifyStoreFailure(diskFull).integrity).toBe(false)

    const drillSystem = await startLive()
    system = drillSystem.system
    const beforeRevision = system.observe().stateRevision

    system.fillDisk()
    await tickUntil(
      system,
      (candidate) => candidate.observe().consecutiveWriterFailures > 0,
      'a writer pass refused by a full disk',
      90,
    )
    await tickUntil(system, notLive, 'degrade on a full disk')

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.supervisor.health().safeStop).toBeNull()
    expect(system.refusedWrites).toBeGreaterThan(0)
    // 부분 commit 없음: nothing advanced past what was committed before.
    expect(system.store.loadRecoveryState().stateRevision).toBe(beforeRevision)

    // And it clears the way §9.1 says an operational condition clears.
    system.freeDisk()
    await tickUntil(system, live, 'recovery once space is free', 90)
  })
})

describe('F-13 WebGL context loss', () => {
  it('degrades the renderer family and recovers through a source restart', async () => {
    const row = drill('F-13')
    const drillSystem = await startLive()
    system = drillSystem.system
    const beforeProcessed = system.observe().processedIngestSeq

    system.renderer.loseWebglContext()
    await tickUntil(system, notLive, 'degrade on WebGL context loss')
    expect(system.supervisor.aggregate?.degradedFamilies).toContain('renderer')

    await tickUntil(system, live, 'automatic recovery of the renderer', 90)

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.renderer.webglContextLost).toBe(false)
    expect(system.observe().processedIngestSeq).toBe(beforeProcessed)
  })
})

describe('F-18 재시작 예산 소진', () => {
  it('stops safely once a component cannot be restarted back to health', async () => {
    const row = drill('F-18')
    const drillSystem = await startLive()
    system = drillSystem.system

    system.chat.fail({ httpStatus: 403, reason: 'quotaExceeded', polls: null })
    await tickUntil(system, stopped, 'safe stop after the chat restart budget', 120)

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.supervisor.health().safeStop?.kind).toBe('restart_budget_exhausted')
    const chat = system.supervisor.components().find((entry) => entry.component === 'chat-source')
    expect(chat?.exhausted).toBe(true)
    expect(system.alerts.ofKind('supervisor.safe_stopped')).toHaveLength(1)
  })
})

describe('coverage', () => {
  it('every fault matrix row has a drill', () => {
    // The four crash windows are drilled in `crash-windows.test.ts`; they are
    // listed here so a new row without any drill at all still fails.
    const elsewhere = ['F-14', 'F-15', 'F-16', 'F-17']
    const drilled = [...covered, ...elsewhere].sort()
    expect(drilled).toEqual(FAULT_MATRIX.map((row) => row.id).sort())
  })

  it('uses the same slice as the supervisor heartbeat allows', () => {
    expect(SLICE_MS).toBeLessThanOrEqual(15_000)
  })
})
