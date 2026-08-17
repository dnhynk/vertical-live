/**
 * Crash-window helper for `crash.test.ts`.
 *
 * Runs in its own process, reaches the requested point, reports `ready` on
 * stdout and then idles until the parent kills it with SIGKILL. That is the
 * closest reproduction of a host crash a test can make: no `finally`, no
 * `process.on('exit')`, no clean SQLite shutdown. The parent then reopens the
 * same file and asserts what survived (TASK_SPECS §T4 합격 기준 1).
 *
 * Deliberately plain SQL over `better-sqlite3`: the point is what WAL plus
 * `synchronous = FULL` guarantee about a half-written transaction, so the child
 * must not depend on the module under test to reach that state. The migrated
 * schema comes from the parent.
 *
 * Usage: node crash-child.mjs <dbFile> <busyTimeoutMs> <mode>
 */
import process from 'node:process'

import Database from 'better-sqlite3'

const [file, busyTimeoutMs, mode] = process.argv.slice(2)
if (file === undefined || busyTimeoutMs === undefined || mode === undefined) {
  process.stderr.write('usage: crash-child.mjs <dbFile> <busyTimeoutMs> <mode>\n')
  process.exit(2)
}

const database = new Database(file)
database.pragma(`busy_timeout = ${busyTimeoutMs}`)
database.pragma('journal_mode = WAL')
database.pragma('synchronous = FULL')

const ENVELOPE = JSON.stringify({
  schemaVersion: 1,
  sourceShape: 'grpc',
  source: 'youtube',
  broadcastId: 'brd_test_0001',
  liveChatId: 'chat_test_0001',
  receivedAt: '2026-08-16T00:05:00.000Z',
  messageId: 'msg_test_crash_0001',
  validationStatus: 'valid',
  kind: 'CHAT_COMMAND',
  occurredAt: '2026-08-16T00:04:59.000Z',
  command: { name: 'FEED', argument: null },
  payment: null,
})

/** Shape-only snapshot and engine state: no author, no name, no chat line. */
const SNAPSHOT = JSON.stringify({
  schemaVersion: 1,
  stateRevision: 9,
  processedIngestSeq: 4,
  worldTimeUtc: '2026-08-16T00:05:00.000Z',
  inputMode: 'direct',
  interactionEnabled: true,
  broadcastLifecycle: 'live',
  creature: {
    creatureId: 'test_creature',
    lifeStage: 'test_stage',
    growthStage: 'test_growth',
    needId: 'test_need',
    emotionId: 'test_emotion',
    bondProgress: { current: 1, target: 100 },
    growthProgress: { current: 1, target: 100 },
  },
  mission: null,
  environment: {
    environmentId: 'test_environment',
    worldPhaseId: 'test_phase',
    weatherId: 'test_weather',
    chapterId: 'test_chapter',
    chapterProgress: { current: 1, target: 3 },
  },
  nextTransitionAt: '2026-08-16T00:10:00.000Z',
  display: {
    currentNeedOrMission: { textKey: 'test.need', iconId: 'test_icon' },
    lastAppliedAction: null,
    growthOrChapterProgress: { textKey: 'test.progress', progress: { current: 1, target: 3 } },
    nextChoiceAt: null,
  },
})

const ENGINE_STATE = JSON.stringify({
  version: 1,
  inputMode: 'direct',
  world: {
    world: { seed: 'seed_test_crash', stepIndex: 4, worldTimeUtc: '2026-08-16T00:05:00.000Z' },
    audit: { pendingThanks: [], acknowledgedEventKeys: [] },
  },
})

const THANKS_PAYLOAD = JSON.stringify({
  paidEventKind: 'SUPER_CHAT',
  iconId: 'test_thanks_icon',
  tier: 1,
  fallback: false,
})

switch (mode) {
  // Crash window "inbox insert 뒤 / checkpoint 전": the row is written inside an
  // open transaction and the process dies before COMMIT.
  case 'inbox-then-kill': {
    database.exec('BEGIN IMMEDIATE')
    database
      .prepare(
        `INSERT INTO ingest_inbox
           (message_id, source, source_shape, broadcast_id, live_chat_id, received_at,
            validation_status, gift_effective_count, envelope_json)
         VALUES (?, 'youtube', 'grpc', 'brd_test_0001', 'chat_test_0001',
                 '2026-08-16T00:05:00.000Z', 'valid', 0, ?)`,
      )
      .run('msg_test_crash_0001', ENVELOPE)
    break
  }

  // A committed paid audit row: `synchronous = FULL` syncs the WAL at COMMIT, so
  // the row must survive the kill.
  case 'commit-paid-then-kill': {
    database.exec('BEGIN IMMEDIATE')
    database
      .prepare(
        `INSERT INTO paid_ledger (event_key, kind, amount_micros, currency, tier, jewels, applied_at)
         VALUES (?, 'SUPER_CHAT', 500000000, 'JPY', 1, NULL, '2026-08-16T00:05:00.000Z')`,
      )
      .run('youtube:brd_test_0001:msg_test_crash_0002')
    database.exec('COMMIT')
    break
  }

  // Crash window "effect 기록 뒤 / ACK 전": the effect is committed and marked
  // published, then the process dies before any ACK can arrive.
  case 'publish-effect-then-kill': {
    database.exec('BEGIN IMMEDIATE')
    database
      .prepare(
        `INSERT INTO effect_outbox
           (effect_id, cause_kind, caused_by_event_key, kind, paid, state_revision, starts_at,
            ends_at, payload_json, published_at)
         VALUES (?, 'event', 'youtube:brd_test_0001:msg_test_0003', 'PAID_THANKS', 1, 1,
                 '2026-08-16T00:05:01.000Z', '2026-08-16T00:05:06.000Z', ?,
                 '2026-08-16T00:05:01.500Z')`,
      )
      .run('eff_test_crash_0001', THANKS_PAYLOAD)
    database.exec('COMMIT')
    break
  }

  // Crash window "state 쓰기 중" with the writer's own domain state attached
  // (migration 004): the snapshot and `engine_state_json` are one row written in
  // one transaction, so a kill before COMMIT must leave neither behind. If they
  // could disagree, a restart would resume a world the recovery cursor has
  // already moved past (TASK_SPECS §T8).
  case 'state-with-engine-then-kill': {
    database.exec('BEGIN IMMEDIATE')
    database
      .prepare(
        `INSERT INTO world_snapshot
           (world_id, state_revision, processed_ingest_seq, snapshot_json, engine_state_json, updated_at)
         VALUES ('default', 9, 4, ?, ?, '2026-08-16T00:05:00.000Z')`,
      )
      .run(SNAPSHOT, ENGINE_STATE)
    break
  }

  default:
    process.stderr.write(`unknown mode ${mode}\n`)
    process.exit(2)
}

// The parent kills the process from here. The handle and, for
// `inbox-then-kill`, the open transaction are deliberately left as they are.
process.stdout.write('ready\n')
setInterval(() => {
  /* keep the event loop alive until SIGKILL arrives */
}, 1000)
