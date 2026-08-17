import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyOAuthErrorBody,
  classifySqliteError,
  classifyYouTubeApiError,
  PersistenceStore,
  simulatorSourceKey,
  systemClock,
  type SourceCheckpointInput,
} from '@vl/server'
import { classifyStoreFailure } from '@vl/server/supervisor'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SOAK_LIVE_CHAT_ID, soakCommandBatch } from '../events.js'
import { crashChild, type CrashChildMode } from '../injection/crash.js'
import { fillDisk, freeDisk, WriteLockHolder, type SqliteConnection } from '../injection/storage.js'
import { SoakSystem } from '../system.js'
import { FAULT_MATRIX, requireFaultRow, type FaultMatrixRow } from './rows.js'
import { SLICE_MS, startLive, tick, tickUntil } from './support.js'

/**
 * Fault matrix drills (TASK_SPECS §T15 합격 기준 1: "matrix 모든 행이 자동
 * 테스트로 존재하고 예상 상태와 일치").
 *
 * Every row of `rows.ts` is injected here, into a **real** supervised system —
 * the real aggregator, the real §9.2 transition table, the real restart
 * supervisors, the real engine and the real SQLite store — and the observed §9.2
 * state is compared with the row's fixed `expectedState`. Where the product owns
 * a classifier, the drill first asserts that the classifier and the row agree, so
 * the expectation being checked is never one this file invented.
 *
 * The crash rows (F-10, F-14 … F-17) are real process-boundary crashes: a child
 * process runs the product's own store and engine, parks at the named commit
 * boundary and is `SIGKILL`ed there (`injection/crash-child.ts`). The system that
 * then has to recover is a real supervised system started on the file the killed
 * engine left behind — so the recovery assertions cannot pass on a clean restart.
 *
 * All eighteen live in one file on purpose: the coverage check at the bottom is
 * derived from the drills that actually ran, and a registry shared across vitest
 * files would not be.
 */

/**
 * The connection `PersistenceStore` opened, captured by wrapping the factory it
 * calls.
 *
 * `max_page_count` is a **per-connection** limit that SQLite does not store in
 * the file (measured: setting it on one connection and reopening reports the
 * default again), so the only way to make the *product's* store hit a real
 * `SQLITE_FULL` is to cap the connection the store itself is using. Nothing else
 * about `openDatabase` changes, and no other drill is affected: the wrapper only
 * records the connection.
 */
const openedConnections = vi.hoisted(() => ({ last: null as SqliteConnection | null }))

vi.mock('../../../../apps/server/src/db/open.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/server/src/db/open.js')>()
  return {
    ...actual,
    openDatabase: (options: Parameters<typeof actual.openDatabase>[0]) => {
      const database = actual.openDatabase(options)
      openedConnections.last = database as unknown as SqliteConnection
      return database
    },
  }
})

/** Rows this run actually drilled. The coverage check reads it, nothing else. */
const drilled = new Set<string>()

function drill(id: string): FaultMatrixRow {
  drilled.add(id)
  return requireFaultRow(id)
}

let system: SoakSystem | undefined
const crashDirectories: string[] = []

afterEach(async () => {
  await system?.close()
  system = undefined
  while (crashDirectories.length > 0) {
    rmSync(crashDirectories.pop() as string, { recursive: true, force: true })
  }
})

const live = (candidate: SoakSystem): boolean => candidate.supervisor.state === 'live'
const notLive = (candidate: SoakSystem): boolean => candidate.supervisor.state !== 'live'
const stopped = (candidate: SoakSystem): boolean => candidate.supervisor.state === 'safe_stopped'

const CHECKPOINT: SourceCheckpointInput = {
  sourceKey: simulatorSourceKey(SOAK_LIVE_CHAT_ID),
  liveChatId: SOAK_LIVE_CHAT_ID,
  nextPageToken: 'soak_probe_token',
}

/**
 * Kills a real engine at `mode`'s boundary and returns the file it left behind.
 *
 * The child creates and migrates the database itself, so nothing in this process
 * has ever held it: whatever is on disk afterwards was put there by the engine
 * that died.
 */
async function crashAt(mode: CrashChildMode): Promise<{
  readonly file: string
  readonly reported: { readonly stateRevision: number; readonly processedIngestSeq: number } | null
}> {
  const directory = mkdtempSync(join(tmpdir(), 'vl-soak-crash-'))
  crashDirectories.push(directory)
  const file = join(directory, 'vertical-live.db')
  const result = await crashChild(file, mode)
  return { file, reported: result.state }
}

/** Reads what the crash left on disk, without starting anything that writes. */
function inspect<T>(file: string, read: (store: PersistenceStore) => T): T {
  const store = PersistenceStore.open({ file, busyTimeoutMs: 2_000, clock: systemClock })
  try {
    return read(store)
  } finally {
    store.close()
  }
}

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
    // Data preservation: what is on disk is what the engine reports, and nothing
    // was rolled back by the stop.
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
    const { file, reported } = await crashAt('host-crash')

    // What the killed engine had reached before the kill, in its own words.
    expect(reported).not.toBeNull()
    expect(reported?.processedIngestSeq).toBe(3)
    const revisionBeforeCrash = reported?.stateRevision ?? 0
    expect(revisionBeforeCrash).toBeGreaterThan(0)

    // What the crash left on disk: five committed rows, the cursor still at
    // three, and the last committed state (spec §11 상태 복구).
    const onDisk = inspect(file, (store) => ({
      recovery: store.loadRecoveryState(),
      undrained: store.drainUnprocessed(store.loadRecoveryState().processedIngestSeq, 100).length,
      checkpoint: store.getSourceCheckpoint(CHECKPOINT.sourceKey)?.nextPageToken ?? null,
    }))
    expect(onDisk.recovery.processedIngestSeq).toBe(3)
    expect(onDisk.recovery.stateRevision).toBe(revisionBeforeCrash)
    expect(onDisk.recovery.snapshot).not.toBeNull()
    expect(onDisk.recovery.engineState).not.toBeNull()
    expect(onDisk.undrained).toBe(2)
    expect(onDisk.checkpoint).toBe('token_undrained')

    // The supervised system that has to come back from it.
    const drillSystem = await startLive({ file })
    system = drillSystem.system
    await tick(system, 2)

    expect(system.supervisor.state).toBe(row.expectedState)
    // The two rows the cursor had not passed were drained, not buried.
    expect(system.observe().processedIngestSeq).toBe(5)
    expect(system.observe().stateRevision).toBeGreaterThanOrEqual(revisionBeforeCrash)
    expect(system.store.drainUnprocessed(system.observe().processedIngestSeq, 100)).toEqual([])
    // Deadlines came back with the state, so the world keeps moving on its own.
    await tick(system, 20)
    expect(system.observe().stateRevision).toBeGreaterThan(revisionBeforeCrash)
  }, 120_000)
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
  it('fails the store transaction atomically and degrades without stopping', async () => {
    const row = drill('F-12')
    const drillSystem = await startLive()
    system = drillSystem.system

    // The connection the product's store is using — see `openedConnections`.
    const connection = openedConnections.last
    expect(connection).not.toBeNull()

    // The disk fills while there is work in the inbox, so the writer's own pass
    // is the transaction that meets it: draining those rows has to write their
    // processing records, and that needs pages the file no longer has.
    system.pumpAfterIngest = false
    await system.inject(200)
    system.pumpAfterIngest = true

    const beforeRevision = system.observe().stateRevision
    const beforeProcessed = system.observe().processedIngestSeq
    const beforeUndrained = system.store.drainUnprocessed(beforeProcessed, 400).length
    expect(beforeUndrained).toBe(200)
    const beforeToken =
      system.store.getSourceCheckpoint(CHECKPOINT.sourceKey)?.nextPageToken ?? null

    fillDisk(connection as SqliteConnection)

    // A real production write path, on the real store, with the real disk full.
    let captured: unknown
    try {
      system.store.commitIngestBatch(
        soakCommandBatch(900, 64, system.clock.nowUtcIso()),
        CHECKPOINT,
      )
    } catch (error) {
      captured = error
    }
    expect(classifySqliteError(captured).kind).toBe('disk_full')
    // §11 안전 정지 is for integrity failures; a full disk is an operational one
    // the operator can clear (§9.1), so it must not be classified as integrity.
    expect(classifyStoreFailure(captured).integrity).toBe(false)

    // Atomicity: not one row of the refused batch reached the inbox, and the
    // checkpoint it carried was not written either.
    expect(system.store.drainUnprocessed(beforeProcessed, 400)).toHaveLength(beforeUndrained)
    expect(system.store.getSourceCheckpoint(CHECKPOINT.sourceKey)?.nextPageToken ?? null).toBe(
      beforeToken,
    )

    await tickUntil(
      system,
      (candidate) => candidate.observe().consecutiveWriterFailures > 0,
      'a writer pass refused by a full disk',
      90,
    )
    expect(system.engine.health().lastFailure?.error ?? '').toMatch(
      /database or disk is full|SQLITE_FULL/i,
    )
    await tickUntil(system, notLive, 'degrade on a full disk')

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.supervisor.health().safeStop).toBeNull()
    // No half-written state: what the engine reports is what is on disk, and no
    // revision that was committed before the disk filled was lost. (Passes that
    // fit in the pages the file already had do commit — a full disk stops growth,
    // not every write — so this is "nothing partial", not "nothing at all".)
    expect(system.store.loadRecoveryState().stateRevision).toBe(system.observe().stateRevision)
    expect(system.observe().stateRevision).toBeGreaterThanOrEqual(beforeRevision)

    // And it clears the way §9.1 says an operational condition clears.
    freeDisk(connection as SqliteConnection)
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

describe('F-14 crash window: inbox commit 전', () => {
  it('leaves no inbox row and no checkpoint, and the run comes back live', async () => {
    const row = drill('F-14')
    const { file } = await crashAt('inbox-commit')

    // The transaction was open when the process died, so none of it happened.
    const onDisk = inspect(file, (store) => ({
      undrained: store.drainUnprocessed(0, 10).length,
      checkpoint: store.getSourceCheckpoint(CHECKPOINT.sourceKey),
      recovery: store.loadRecoveryState(),
    }))
    expect(onDisk.undrained).toBe(0)
    expect(onDisk.checkpoint).toBeNull()
    expect(onDisk.recovery.processedIngestSeq).toBe(0)

    const drillSystem = await startLive({ file })
    system = drillSystem.system
    expect(system.supervisor.state).toBe(row.expectedState)

    // The source re-delivers what was never committed, and it applies once.
    await system.inject(1)
    await tick(system, 2)
    expect(system.observe().processedIngestSeq).toBe(1)
  }, 120_000)
})

describe('F-15 crash window: inbox·token checkpoint commit 직후 / state commit 전', () => {
  it('keeps the rows and the resume token, and drains them after the restart', async () => {
    const row = drill('F-15')
    const { file } = await crashAt('state-commit')

    // Rows and token are one transaction, so both are there; the cursor is not.
    const onDisk = inspect(file, (store) => ({
      undrained: store.drainUnprocessed(0, 10).length,
      token: store.getSourceCheckpoint(CHECKPOINT.sourceKey)?.nextPageToken ?? null,
      processed: store.loadRecoveryState().processedIngestSeq,
    }))
    expect(onDisk.undrained).toBe(1)
    expect(onDisk.token).toBe('token_committed')
    expect(onDisk.processed).toBe(0)

    const drillSystem = await startLive({ file })
    system = drillSystem.system
    await tick(system, 2)

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.observe().processedIngestSeq).toBe(1)
    expect(system.store.getSourceCheckpoint(CHECKPOINT.sourceKey)?.nextPageToken).toBe(
      'token_committed',
    )
  }, 120_000)
})

describe('F-16 crash window: state commit 직후 / effect 발행 전', () => {
  it('keeps the committed state and publishes the effect after the restart', async () => {
    const row = drill('F-16')
    const { file } = await crashAt('effect-publish')

    // Committed, durable and never published: the §7.3(6) window.
    const onDisk = inspect(file, (store) => {
      const recovery = store.loadRecoveryState()
      return {
        stateRevision: recovery.stateRevision,
        unacked: recovery.unackedEffects.map((entry) => ({
          effectId: entry.effect.effectId,
          publishedAt: entry.publishedAt,
          ackedAt: entry.ackedAt,
        })),
      }
    })
    expect(onDisk.stateRevision).toBeGreaterThan(0)
    // The effect the kill caught mid-publish: committed to the outbox, never
    // marked published. (Effects the cold start had already published sit beside
    // it, which is why this looks for the unpublished ones rather than all.)
    const unpublished = onDisk.unacked.filter((entry) => entry.publishedAt === null)
    expect(unpublished.length).toBeGreaterThan(0)

    const drillSystem = await startLive({ file })
    system = drillSystem.system
    await tick(system, 2)

    expect(system.supervisor.state).toBe(row.expectedState)
    expect(system.store.loadRecoveryState().stateRevision).toBeGreaterThanOrEqual(
      onDisk.stateRevision,
    )
    // Every effect the crash left unpublished reached the renderer after it, was
    // applied, and its ACK was recorded — so nothing was silently dropped.
    const delivered = system.renderer.effectFrames.map((effect) => effect.effectId)
    const stillUnacked = system.store.listUnackedEffects().map((entry) => entry.effect.effectId)
    for (const entry of unpublished) {
      expect(delivered).toContain(entry.effectId)
      expect(stillUnacked).not.toContain(entry.effectId)
    }
  }, 120_000)
})

describe('F-17 crash window: effect 발행 직후 / ACK 전', () => {
  it('recovers the effect as unacked and republishes it under the same id', async () => {
    const row = drill('F-17')
    const { file } = await crashAt('effect-ack')

    const onDisk = inspect(file, (store) =>
      store.listUnackedEffects().map((entry) => ({
        effectId: entry.effect.effectId,
        publishedAt: entry.publishedAt,
        ackedAt: entry.ackedAt,
      })),
    )
    expect(onDisk.length).toBeGreaterThan(0)
    // Published before the kill, never acknowledged by anyone.
    expect(onDisk.every((entry) => entry.publishedAt !== null && entry.ackedAt === null)).toBe(true)

    const drillSystem = await startLive({ file })
    system = drillSystem.system
    await tick(system, 2)

    expect(system.supervisor.state).toBe(row.expectedState)
    // Republished under the **same** id. §7.3(7) allows the retransmission — the
    // rule §11 유료 무결성 states is that a repeat must not start the staging
    // again, which is why the renderer counts a repeated frame instead of
    // playing it, and why the id is played exactly once however often it arrives.
    const delivered = system.renderer.effectFrames.map((effect) => effect.effectId)
    const stillUnacked = system.store.listUnackedEffects().map((entry) => entry.effect.effectId)
    for (const entry of onDisk) {
      expect(delivered).toContain(entry.effectId)
      // Applied and acknowledged after the crash: not silently dropped.
      expect(stillUnacked).not.toContain(entry.effectId)
    }
    expect(system.renderer.distinctEffects).toBe(new Set(delivered).size)
  }, 120_000)
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
  it('every fault matrix row was drilled in this run', () => {
    // Derived from the drills that ran, not from a list kept beside them: a row
    // added to `rows.ts` without a drill fails here, and so does a drill that
    // never reached its `drill(id)` call because it errored first.
    expect([...drilled].sort()).toEqual(FAULT_MATRIX.map((row) => row.id).sort())
  })

  it('uses a slice the supervisor heartbeat window allows', () => {
    expect(SLICE_MS).toBeLessThanOrEqual(15_000)
  })
})
