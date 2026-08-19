import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Clock, TimerHandle } from '../clock.js'
import { openDatabase } from '../db/index.js'
import { createTempStore } from '../db/testing/temp-store.js'
import {
  createEngineHarness,
  TEST_EPOCH_MS,
  type EngineHarness,
} from '../engine/testing/harness.js'
import { createCommandParserPort, loadInputConfig, parserLimits } from '../input/index.js'
import { loadRetentionConfig } from '../privacy/config.js'
import { UserDeletionRequestHandler } from '../privacy/deletion-request.js'
import { RetentionSweeper } from '../privacy/retention.js'
import { RevocationHandler } from '../privacy/revocation.js'
import type { LogFields } from '../secrets/redaction.js'
import { testChatConfig } from '../testing/chat-test-support.js'
import { FakeClock } from '../testing/fake-clock.js'
import {
  ChatIngestSink,
  ConsentObserveError,
  type ConsentFailure,
  type ConsentObserver,
} from '../youtube/chat/sink.js'
import { chatRuntimeDeps } from '../youtube/chat/wiring.js'
import { ConsentDirectory } from './directory.js'

/**
 * The consent mode of BOARD D-9, end to end: a raw gRPC item goes through the
 * chat sink, the consent directory, the inbox and the single writer, and the
 * question is what reaches the screen and what reaches the disk.
 *
 * TASK_SPECS §T20b acceptance 1:
 *  - `JOIN` → the display name is attached → `LEAVE` → anonymous again;
 *  - a non-consenting viewer's `authorDetails` is in **no** store and **no** log;
 *  - 30 days of inactivity deletes the record (virtual clock);
 *  - the closed configuration behaves exactly as it did before.
 *
 * Every identifier is obviously synthetic (spec §2.6).
 */

const BROADCAST_ID = 'brd_test_engine'
const LIVE_CHAT_ID = 'chat_test_engine'
const JOINER = 'UC_TEST_synthetic_viewer_join'
const JOINER_NAME = 'synthetic-viewer-join'
const LURKER = 'UC_TEST_synthetic_viewer_lurker'
const LURKER_NAME = 'synthetic-viewer-lurker'

interface Fixture {
  readonly harness: EngineHarness
  readonly sink: ChatIngestSink
  readonly directory: ConsentDirectory | null
  readonly logs: string[]
  /** Consent decisions the sink could not apply, in order (review round 1, B3). */
  readonly consentFailures: ConsentFailure[]
  dispose(): void
}

interface BuildOptions {
  /** Wraps the live directory, so a test can make one decision fail. */
  readonly wrapConsent?: (directory: ConsentDirectory) => ConsentObserver
  /**
   * The clock the *store* reads, separate from the one everything else reads.
   * `commitIngestBatch` stamps the checkpoint from it as the last step of its
   * transaction, so an armed failure here rolls a batch back after the consent
   * hook has already run (review round 2, B2).
   */
  readonly storeClock?: Clock
}

let fixture: Fixture | undefined

afterEach(() => {
  fixture?.dispose()
  fixture = undefined
})

/**
 * A clock that fails one reading on demand. Given to the *store* only, it makes
 * `commitIngestBatch` throw where it stamps the checkpoint — the last step of
 * its transaction, after the consent hook has run (review round 2, B2).
 */
class ArmedClock implements Clock {
  readonly #inner: Clock
  #armed = false

  constructor(inner: Clock) {
    this.#inner = inner
  }

  armFailure(): void {
    this.#armed = true
  }

  nowUtcIso(): string {
    if (this.#armed) {
      this.#armed = false
      throw new Error('checkpoint write failed')
    }
    return this.#inner.nowUtcIso()
  }

  monotonicMs(): number {
    return this.#inner.monotonicMs()
  }

  setTimeout(handler: () => void, delayMs: number): TimerHandle {
    return this.#inner.setTimeout(handler, delayMs)
  }

  clearTimeout(handle: TimerHandle): void {
    this.#inner.clearTimeout(handle)
  }
}

/** One `LiveChatMessage` as the gRPC transport delivers it ([S4] proto). */
function chatItem(options: {
  readonly messageId: string
  readonly text: string
  readonly channelId?: string
  readonly displayName?: string
}): unknown {
  return {
    id: options.messageId,
    snippet: {
      type: 'TEXT_MESSAGE_EVENT',
      live_chat_id: LIVE_CHAT_ID,
      published_at: '2026-08-16T00:00:00.000Z',
      text_message_details: { message_text: options.text },
    },
    ...(options.channelId === undefined
      ? {}
      : {
          author_details: {
            channel_id: options.channelId,
            display_name: options.displayName ?? 'synthetic-viewer',
            profile_image_url: 'https://example.invalid/avatar_test.png',
          },
        }),
  }
}

/**
 * Wires the pieces the way `main.ts` does: one store, one clock, a consent
 * directory only when the gate is open, and the same directory handed to both
 * the sink (which sees the raw item) and the engine (which needs the actor).
 */
function build(identityGateOpen: boolean, options: BuildOptions = {}): Fixture {
  const logs: string[] = []
  const record = (message: string, fields?: LogFields): void => {
    logs.push(`${message} ${JSON.stringify(fields ?? {})}`)
  }
  const logger = { debug: record, info: record, warn: record, error: record }

  const clock = new FakeClock({ epochMs: TEST_EPOCH_MS })
  const temp = createTempStore({ clock: options.storeClock ?? clock })
  const directory = identityGateOpen
    ? new ConsentDirectory({
        store: temp.store,
        clock,
        retention: loadRetentionConfig(),
        logger,
      })
    : null
  const harness = createEngineHarness({
    temp,
    clock,
    ...(directory === null ? {} : { identity: directory }),
  })

  const inputConfig = loadInputConfig({ env: {} })
  const consentFailures: ConsentFailure[] = []
  const observer =
    directory === null ? null : (options.wrapConsent?.(directory) ?? (directory as ConsentObserver))
  // The inbox and the consent observer come from the wiring `main.ts` passes,
  // not from a hand-rolled adapter: a fixture that builds its own inbox is what
  // let the production wiring drop the commit hooks (review round 2, B1).
  const deps = chatRuntimeDeps({
    store: temp.store,
    engine: harness.engine,
    clock,
    inputConfig,
    identityGateOpen,
    consent: observer,
    config: testChatConfig({ enabled: true }),
    logger,
    auth: null,
    resolveTarget: null,
  })
  const sink = new ChatIngestSink({
    inbox: deps.inbox,
    clock,
    parseCommand: createCommandParserPort({
      context: () => ({ identityGateOpen, voteWindowOpen: false }),
      limits: parserLimits(inputConfig),
    }),
    sourceKey: `youtube:${LIVE_CHAT_ID}`,
    liveChatId: LIVE_CHAT_ID,
    broadcastId: BROADCAST_ID,
    ...(deps.consent === undefined
      ? {}
      : {
          consent: deps.consent,
          onConsentFailure: (failure: ConsentFailure) => consentFailures.push(failure),
        }),
  })
  harness.engine.start()
  return {
    harness,
    sink,
    directory,
    logs,
    consentFailures,
    dispose: () => {
      harness.dispose()
      temp.dispose()
    },
  }
}

/** Feeds one response through the sink and lets the writer drain it. */
function deliver(active: Fixture, items: readonly unknown[]): void {
  active.sink.commit({ sourceShape: 'grpc', items, nextPageToken: 'token_test_0001' })
  active.harness.engine.pump()
}

/** Every row of every table, as text — the "is it anywhere on disk" probe. */
function dumpDatabase(file: string): string {
  const database = openDatabase({ file, busyTimeoutMs: 1000 })
  try {
    const tables = database
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`,
      )
      .all()
    return tables
      .map(
        (table) =>
          `${table.name}: ${JSON.stringify(database.prepare(`SELECT * FROM "${table.name}"`).all())}`,
      )
      .join('\n')
  } finally {
    database.close()
  }
}

/**
 * Makes one field's `retention_ledger` rows fail, and only that field's. Used to
 * abort a run *after* the consent rows are already deleted, which is the shape of
 * review round 3: the deletion is final, the run is not.
 */
function blockLedgerInsertsFor(file: string, fieldKey: string): void {
  const database = openDatabase({ file, busyTimeoutMs: 1000 })
  try {
    database.exec(
      `CREATE TRIGGER retention_ledger_block BEFORE INSERT ON retention_ledger
       WHEN NEW.field_key = '${fieldKey}'
       BEGIN SELECT RAISE(ABORT, 'ledger unavailable for ${fieldKey.split('.')[0]}'); END`,
    )
  } finally {
    database.close()
  }
}

/**
 * A joined viewer with one committed but not yet drained message: the display
 * name exists only in the directory's buffer when the deletion runs, which is
 * the only way it can outlive the row.
 */
function withBufferedActor(): Fixture {
  const active = build(true)
  fixture = active
  deliver(active, [
    chatItem({
      messageId: 'msg_test_join',
      text: 'なのる',
      channelId: JOINER,
      displayName: JOINER_NAME,
    }),
  ])
  active.sink.commit({
    sourceShape: 'grpc',
    items: [
      chatItem({
        messageId: 'msg_test_feed_buffered',
        text: 'ごはん',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ],
    nextPageToken: 'token_test_buffered',
  })
  expect((active.directory as ConsentDirectory).pendingCount).toBe(1)
  return active
}

/** The production revocation handler, wired to this fixture's live directory. */
function revocationHandler(active: Fixture): RevocationHandler {
  return new RevocationHandler({
    store: active.harness.store,
    clock: active.harness.clock,
    config: loadRetentionConfig(),
    grantRevoker: { revoke: () => Promise.resolve('nothing_stored' as const) },
    identity: active.directory as ConsentDirectory,
  })
}

/** The action reactions published so far, newest last. */
function reactions(active: Fixture): { actor?: unknown }[] {
  return active.harness.publisher.effects.filter(
    (effect) => effect.kind === 'ACTION_REACTION',
  ) as unknown as { actor?: unknown }[]
}

describe('consent mode (BOARD D-9)', () => {
  beforeEach(() => {
    fixture = undefined
  })

  it('joins, attaches the name, leaves, and is anonymous again', () => {
    const active = build(true)
    fixture = active

    deliver(active, [
      chatItem({
        messageId: 'msg_test_join',
        text: 'なのる',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    const stored = active.harness.store.findConsentByChannelId(JOINER)
    expect(stored?.displayName).toBe(JOINER_NAME)
    // The consent command moves no world state: it produced no reaction.
    expect(reactions(active)).toHaveLength(0)

    active.harness.clock.advance(60_000)
    deliver(active, [
      chatItem({
        messageId: 'msg_test_feed_1',
        text: 'ごはん',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    const named = reactions(active).at(-1)
    expect(named?.actor).toEqual({
      kind: 'consented',
      displayName: JOINER_NAME,
      channelRef: stored?.channelRef,
    })

    active.harness.clock.advance(60_000)
    deliver(active, [
      chatItem({
        messageId: 'msg_test_leave',
        text: 'なまえけす',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    expect(active.harness.store.findConsentByChannelId(JOINER)).toBeNull()

    active.harness.clock.advance(60_000)
    const before = reactions(active).length
    deliver(active, [
      chatItem({
        messageId: 'msg_test_feed_2',
        text: 'ごはん',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    const afterLeave = reactions(active).slice(before)
    expect(afterLeave.length).toBeGreaterThan(0)
    for (const effect of afterLeave) expect(effect.actor ?? null).toBeNull()
  })

  it('leaves no trace of a viewer who never consented', () => {
    const active = build(true)
    fixture = active

    deliver(active, [
      chatItem({
        messageId: 'msg_test_lurk',
        text: 'ごはん',
        channelId: LURKER,
        displayName: LURKER_NAME,
      }),
    ])

    expect(active.harness.store.countRows('viewer_consent')).toBe(0)
    // The command was applied — this is a viewer taking part anonymously, not a
    // message that was dropped.
    expect(reactions(active).length).toBeGreaterThan(0)
    for (const effect of reactions(active)) expect(effect.actor ?? null).toBeNull()

    const surfaces = [
      dumpDatabase(active.harness.temp.file),
      JSON.stringify(active.harness.publisher.snapshots),
      JSON.stringify(active.harness.publisher.effects),
      JSON.stringify(active.harness.engine.metrics()),
      JSON.stringify(active.harness.engine.health()),
      active.logs.join('\n'),
    ]
    for (const surface of surfaces) {
      expect(surface).not.toContain(LURKER)
      expect(surface).not.toContain(LURKER_NAME)
      // Not even the message text that carried them (spec §12.3).
      expect(surface).not.toContain('ごはん')
    }
    // Guards the probe itself: the inbox really did receive the message.
    expect(dumpDatabase(active.harness.temp.file)).toContain('msg_test_lurk')
  })

  it('keeps a consented viewer out of every store except the consent row', () => {
    const active = build(true)
    fixture = active

    deliver(active, [
      chatItem({
        messageId: 'msg_test_join',
        text: 'なのる',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    active.harness.clock.advance(60_000)
    deliver(active, [
      chatItem({
        messageId: 'msg_test_feed_1',
        text: 'ごはん',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])

    const dump = dumpDatabase(active.harness.temp.file)
    // The name is on disk exactly once, in the consent row.
    expect(dump.split(JOINER_NAME).length - 1).toBe(1)
    expect(dump.split(JOINER).length - 1).toBe(1)
    const consentLine = dump.split('\n').find((line) => line.startsWith('viewer_consent:'))
    expect(consentLine).toContain(JOINER)
    expect(consentLine).toContain(JOINER_NAME)
    // The effect the renderer sees carries the name; the outbox row does not, so
    // a republish after a restart is anonymous (spec §7.3(7)).
    expect(JSON.stringify(active.harness.publisher.effects)).toContain(JOINER_NAME)
    const outboxLine = dump.split('\n').find((line) => line.startsWith('effect_outbox:'))
    expect(outboxLine ?? '').not.toContain(JOINER_NAME)
    // And no log line names anybody.
    expect(active.logs.join('\n')).not.toContain(JOINER_NAME)
    expect(active.logs.join('\n')).not.toContain(JOINER)
  })

  it('deletes a consent record after 30 days without a message (virtual clock)', () => {
    const active = build(true)
    fixture = active

    deliver(active, [
      chatItem({
        messageId: 'msg_test_join',
        text: 'なのる',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    expect(active.harness.store.countRows('viewer_consent')).toBe(1)

    const sweeper = new RetentionSweeper({
      store: active.harness.store,
      clock: active.harness.clock,
      config: loadRetentionConfig(),
    })

    // Day 29: still refreshed inside the [S41] III.E.4.c window.
    active.harness.clock.advance(29 * 24 * 60 * 60 * 1000)
    sweeper.run()
    expect(active.harness.store.countRows('viewer_consent')).toBe(1)

    // Day 31: the record stopped being refreshed, so it goes.
    active.harness.clock.advance(2 * 24 * 60 * 60 * 1000)
    const result = sweeper.run()
    expect(active.harness.store.countRows('viewer_consent')).toBe(0)
    const entry = result.entries.find((item) => item.fieldKey === 'viewer_consent.identity')
    expect(entry).toMatchObject({ outcome: 'deleted', rowsDeleted: 1 })
    const ledger = active.harness.store
      .listRetentionLedger({ fieldKey: 'viewer_consent.identity' })
      .filter((row) => row.reason === 'scheduled')
    expect(ledger.at(-1)).toMatchObject({
      outcome: 'deleted',
      rowsDeleted: 1,
      allowedPeriodDays: 30,
    })
    expect(JSON.stringify(ledger)).not.toContain(JOINER_NAME)
  })

  it('does not revive a deleted identity when a page is replayed', () => {
    // Review round 1 (B1). A duplicate page or a reconnect re-delivers the same
    // `messageId`s (spec §7.3(2), §11). The consent decision follows the inbox
    // dedupe, so a replayed `JOIN` is not a second consent.
    const active = build(true)
    fixture = active

    const join = chatItem({
      messageId: 'msg_test_join',
      text: 'なのる',
      channelId: JOINER,
      displayName: JOINER_NAME,
    })
    deliver(active, [join])
    expect(active.harness.store.findConsentByChannelId(JOINER)).not.toBeNull()

    active.harness.clock.advance(60_000)
    deliver(active, [
      chatItem({
        messageId: 'msg_test_leave',
        text: 'なまえけす',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    expect(active.harness.store.findConsentByChannelId(JOINER)).toBeNull()

    // The same page again, exactly as a reconnect would deliver it.
    active.harness.clock.advance(60_000)
    const replay = active.sink.commit({
      sourceShape: 'grpc',
      items: [join],
      nextPageToken: 'token_test_replay',
    })
    active.harness.engine.pump()

    expect(replay.inserted).toBe(0)
    expect(replay.duplicates).toBe(1)
    expect(replay.consentJoined).toBe(0)
    // The withdrawal stands: no row, and no new reference issued for one.
    expect(active.harness.store.findConsentByChannelId(JOINER)).toBeNull()
    expect(active.harness.store.countRows('viewer_consent')).toBe(0)
    expect(dumpDatabase(active.harness.temp.file)).not.toContain(JOINER_NAME)
  })

  it('rolls the batch back when a withdrawal cannot be applied, and deletes on the retry', () => {
    // Review round 1 (B3): withdrawal is fail-closed. The failed batch must not
    // move the checkpoint, or the `LEAVE` is skipped for good and the identity
    // stays until the 30-day sweep (spec §12.4, [S41] III.E.4.g).
    let failWithdrawal = true
    const active = build(true, {
      wrapConsent: (directory) => ({
        observe: (rawItem, envelope) => {
          const isLeave =
            envelope.validationStatus === 'valid' && envelope.consentCommand?.name === 'LEAVE'
          if (isLeave && failWithdrawal) throw new Error('consent store unavailable')
          return directory.observe(rawItem, envelope)
        },
        // The real boundary, so the wrapper does not quietly disable the staging
        // the rolled-back batch depends on (review round 2, B2).
        duringCommit: (write) => directory.duringCommit(write),
      }),
    })
    fixture = active

    deliver(active, [
      chatItem({
        messageId: 'msg_test_join',
        text: 'なのる',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    const committed = active.harness.store.getSourceCheckpoint(`youtube:${LIVE_CHAT_ID}`)
    expect(committed?.nextPageToken).toBe('token_test_0001')

    active.harness.clock.advance(60_000)
    const leave = chatItem({
      messageId: 'msg_test_leave',
      text: 'なまえけす',
      channelId: JOINER,
      displayName: JOINER_NAME,
    })
    expect(() =>
      active.sink.commit({
        sourceShape: 'grpc',
        items: [leave],
        nextPageToken: 'token_after_failed_leave',
      }),
    ).toThrow(ConsentObserveError)

    // Nothing moved: not the checkpoint, not the inbox — so the source refetches
    // these items from the same token instead of skipping the decision.
    expect(active.consentFailures).toEqual([{ kind: 'withdrawal' }])
    expect(active.harness.store.getSourceCheckpoint(`youtube:${LIVE_CHAT_ID}`)?.nextPageToken).toBe(
      'token_test_0001',
    )
    expect(active.harness.store.findConsentByChannelId(JOINER)).not.toBeNull()

    // The retry — same items, same token — deletes.
    failWithdrawal = false
    const retried = active.sink.commit({
      sourceShape: 'grpc',
      items: [leave],
      nextPageToken: 'token_after_failed_leave',
    })
    active.harness.engine.pump()
    expect(retried.consentLeft).toBe(1)
    expect(active.harness.store.findConsentByChannelId(JOINER)).toBeNull()
    expect(active.harness.store.getSourceCheckpoint(`youtube:${LIVE_CHAT_ID}`)?.nextPageToken).toBe(
      'token_after_failed_leave',
    )
  })

  it('answers a deletion request through the same boundary the chat path uses', () => {
    // Review round 1 (B2): the T13 handler deleted the row straight through the
    // store, which left the directory's buffered display name in place — so a
    // message received a moment earlier could still put the name on screen after
    // the request was answered (spec §12.4).
    const active = build(true)
    fixture = active
    const directory = active.directory as ConsentDirectory

    deliver(active, [
      chatItem({
        messageId: 'msg_test_join',
        text: 'なのる',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    // Received, not yet processed: the actor is buffered in memory right now.
    active.harness.clock.advance(60_000)
    active.sink.commit({
      sourceShape: 'grpc',
      items: [
        chatItem({
          messageId: 'msg_test_feed_pending',
          text: 'ごはん',
          channelId: JOINER,
          displayName: JOINER_NAME,
        }),
      ],
      nextPageToken: 'token_test_pending',
    })
    expect(directory.pendingCount).toBe(1)

    const handler = new UserDeletionRequestHandler({
      store: active.harness.store,
      clock: active.harness.clock,
      config: loadRetentionConfig(),
      directory,
    })
    const receipt = handler.handle({ channelId: JOINER })

    expect(receipt.rowsDeleted).toBe(1)
    expect(active.harness.store.findConsentByChannelId(JOINER)).toBeNull()
    // The derived copy went with the row: nothing left to attribute.
    expect(directory.takeActor('msg_test_feed_pending')).toBeNull()
    expect(directory.pendingCount).toBe(0)

    // And the message that was already in the inbox is published anonymously.
    active.harness.engine.pump()
    for (const effect of reactions(active)) expect(effect.actor ?? null).toBeNull()
    expect(JSON.stringify(active.harness.publisher.effects)).not.toContain(JOINER_NAME)
  })

  it('discards a rolled-back attribution, so a swept identity cannot come back on the retry', () => {
    // Review round 2 (B2). `observe` runs inside `commitIngestBatch`'s
    // transaction, so its row writes roll back with the batch — the buffered
    // display name did not. The sequence the reviewer reproduced: attribute a
    // message, fail the checkpoint so the batch rolls back, let the 30-day sweep
    // delete the (now unrefreshed) row, then redeliver the same `messageId`.
    // The retry is anonymous — the row is gone — but the old actor was still
    // waiting under that id, so a deleted person's name reached the screen.
    const storeClock = new ArmedClock(new FakeClock({ epochMs: TEST_EPOCH_MS }))
    const active = build(true, { storeClock })
    fixture = active
    const directory = active.directory as ConsentDirectory

    deliver(active, [
      chatItem({
        messageId: 'msg_test_join',
        text: 'なのる',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    const stored = active.harness.store.findConsentByChannelId(JOINER)
    expect(stored).not.toBeNull()

    // The checkpoint stamp is the last thing the transaction does, so this
    // throws after the hook has attributed the message.
    const attributed = {
      messageId: 'msg_test_feed_rollback',
      text: 'ごはん',
      channelId: JOINER,
      displayName: JOINER_NAME,
    }
    storeClock.armFailure()
    expect(() =>
      active.sink.commit({
        sourceShape: 'grpc',
        items: [chatItem(attributed)],
        nextPageToken: 'token_test_rollback',
      }),
    ).toThrow('checkpoint write failed')

    // Rolled back: no inbox row, and no buffered name either.
    expect(active.harness.store.countRows('ingest_inbox')).toBe(1)
    expect(directory.pendingCount).toBe(0)

    // 31 days without a refresh, and the sweep takes the row ([S41] III.E.4.c).
    const sweeper = new RetentionSweeper({
      store: active.harness.store,
      clock: active.harness.clock,
      config: loadRetentionConfig(),
      identity: directory,
    })
    active.harness.clock.advance(31 * 24 * 60 * 60 * 1000)
    expect(sweeper.run().entries.find((entry) => entry.table === 'viewer_consent')).toMatchObject({
      outcome: 'deleted',
      rowsDeleted: 1,
    })
    expect(active.harness.store.findConsentByChannelId(JOINER)).toBeNull()

    // The retry of the same message: anonymous, because the row is gone. Before
    // the fix this returned the buffered actor of a viewer who had been deleted.
    // Committed without a writer pass on purpose — `engine.pump()` after a
    // 31-day virtual jump catches up beat by beat and does not return, which is
    // the engine's own behaviour and unrelated to this path. `takeActor` is the
    // only way an actor reaches an effect, so it is the assertion that matters.
    const inboxBefore = active.harness.store.countRows('ingest_inbox')
    active.sink.commit({
      sourceShape: 'grpc',
      items: [chatItem(attributed)],
      nextPageToken: 'token_test_retry',
    })
    // The retry really is a fresh insert — the rolled-back batch left no row for
    // it to be deduplicated against.
    expect(active.harness.store.countRows('ingest_inbox')).toBe(inboxBefore + 1)
    expect(directory.takeActor(attributed.messageId)).toBeNull()
    expect(directory.pendingCount).toBe(0)
  })

  it('drops a buffered actor whose row the sweep deleted', () => {
    // The other half of B2: the sweep deletes by SQL batch and cannot use the
    // directory's deletion boundary, so the boundary is reached from the buffer
    // instead. Without this a name buffered before the sweep stayed attributable
    // until the engine happened to drain it.
    const active = build(true)
    fixture = active
    const directory = active.directory as ConsentDirectory

    deliver(active, [
      chatItem({
        messageId: 'msg_test_join',
        text: 'なのる',
        channelId: JOINER,
        displayName: JOINER_NAME,
      }),
    ])
    // Committed, but not drained by the writer: the actor is buffered.
    active.sink.commit({
      sourceShape: 'grpc',
      items: [
        chatItem({
          messageId: 'msg_test_feed_buffered',
          text: 'ごはん',
          channelId: JOINER,
          displayName: JOINER_NAME,
        }),
      ],
      nextPageToken: 'token_test_buffered',
    })
    expect(directory.pendingCount).toBe(1)
    const channelRef = active.harness.store.findConsentByChannelId(JOINER)?.channelRef

    const sweeper = new RetentionSweeper({
      store: active.harness.store,
      clock: active.harness.clock,
      config: loadRetentionConfig(),
      identity: directory,
    })
    // Move past the window without a refresh, then sweep.
    active.harness.clock.advance(31 * 24 * 60 * 60 * 1000)
    sweeper.run()

    expect(active.harness.store.countRows('viewer_consent')).toBe(0)
    expect(directory.pendingCount).toBe(0)
    expect(directory.takeActor('msg_test_feed_buffered')).toBeNull()
    // The reference goes to the arbiter purge queue with the row (round 1, M4).
    expect(directory.drainForgotten()).toContain(channelRef)
  })

  it('drops the buffered actor even when a later field aborts the sweep', () => {
    // Review round 2 (B2) put the sweep and the buffer on the same boundary, but
    // the reconcile still ran once, after the whole field loop. With the shipped
    // config `metrics_daily` is swept immediately after `viewer_consent`, so the
    // sequence the reviewer reproduced in round 3 was: the consent rows commit as
    // deleted, the next field's ledger write fails, the run aborts before the
    // reconcile — and `takeActor` still handed out the name of someone whose
    // record had been deleted, until the scheduler's next hourly tick.
    const active = withBufferedActor()
    const directory = active.directory as ConsentDirectory
    const channelRef = active.harness.store.findConsentByChannelId(JOINER)?.channelRef

    // `metrics_daily` is `status: "planned"`, so its `table_absent` ledger row is
    // written outside the sweeper's per-field error handling: a failure there
    // aborts the whole run, with the consent rows already committed as deleted.
    blockLedgerInsertsFor(active.harness.temp.file, 'metrics_daily.aggregates')
    const sweeper = new RetentionSweeper({
      store: active.harness.store,
      clock: active.harness.clock,
      config: loadRetentionConfig(),
      identity: directory,
    })
    active.harness.clock.advance(31 * 24 * 60 * 60 * 1000)
    expect(() => sweeper.run()).toThrow(/ledger unavailable for metrics_daily/)

    // The consent deletion committed before the abort, so it is final...
    expect(active.harness.store.countRows('viewer_consent')).toBe(0)
    // ...and the memory it authorized went with it, in the same run.
    expect(directory.pendingCount).toBe(0)
    expect(directory.takeActor('msg_test_feed_buffered')).toBeNull()
    expect(directory.drainForgotten()).toContain(channelRef)
  })

  it('drops the buffered actor when a revocation deletes the consent rows', async () => {
    // Found while re-checking the round 3 boundary, not raised by a review round.
    // `RevocationHandler` is the fourth path that removes `viewer_consent` rows
    // (LEAVE, the T13 request, the 30-day sweep, this) and it took no reconciler
    // at all: an OAuth withdrawal deleted every row by SQL batch while the live
    // directory kept the buffered display names, so `takeActor` handed out a
    // deleted viewer's name for the rest of the process's life.
    const active = withBufferedActor()
    const directory = active.directory as ConsentDirectory
    const channelRef = active.harness.store.findConsentByChannelId(JOINER)?.channelRef

    const revocation = await revocationHandler(active).handle({
      type: 'auth_revoked',
      at: active.harness.clock.nowUtcIso(),
      reason: 'operator_revoked',
    })

    expect(revocation.entries.find((entry) => entry.table === 'viewer_consent')).toMatchObject({
      outcome: 'deleted',
      rowsDeleted: 1,
    })
    expect(active.harness.store.countRows('viewer_consent')).toBe(0)
    expect(directory.pendingCount).toBe(0)
    expect(directory.takeActor('msg_test_feed_buffered')).toBeNull()
    expect(directory.drainForgotten()).toContain(channelRef)
  })

  it('drops the buffered actor when a field after the consent field aborts a revocation', async () => {
    // The order-independence half. With the shipped config `viewer_consent` is
    // the *last* authorized field, so no later field can abort after it today —
    // this asserts that the guarantee comes from the boundary and not from that
    // ordering, because reordering `config/retention.json` would otherwise
    // silently reintroduce the round 3 blocker on this path.
    const active = withBufferedActor()
    const directory = active.directory as ConsentDirectory
    // The shipped file's own two fields, swept in the opposite order — nothing
    // about the policy is invented here, only the order it is walked in.
    const shipped = loadRetentionConfig()
    const order = ['viewer_consent.identity', 'ingest_inbox.envelope']
    const fields = order.flatMap((key) => shipped.fields.filter((field) => field.key === key))
    expect(fields.map((field) => field.key)).toEqual(order)
    const reordered = { ...shipped, fields }

    blockLedgerInsertsFor(active.harness.temp.file, 'ingest_inbox.envelope')
    await expect(
      new RevocationHandler({
        store: active.harness.store,
        clock: active.harness.clock,
        config: reordered,
        grantRevoker: { revoke: async () => 'nothing_stored' as const },
        identity: directory,
      }).handle({
        type: 'auth_revoked',
        at: active.harness.clock.nowUtcIso(),
        reason: 'operator_revoked',
      }),
    ).rejects.toThrow(/ledger unavailable for ingest_inbox/)

    expect(active.harness.store.countRows('viewer_consent')).toBe(0)
    expect(directory.pendingCount).toBe(0)
    expect(directory.takeActor('msg_test_feed_buffered')).toBeNull()
  })

  it('is inert in the closed configuration', () => {
    // BOARD A-1: no directory is constructed, so `なのる` is refused by the
    // parser and the same items produce exactly the anonymous behaviour.
    const active = build(false)
    fixture = active

    deliver(active, [
      chatItem({ messageId: 'msg_test_join', text: 'なのる', channelId: JOINER }),
      chatItem({ messageId: 'msg_test_feed', text: 'ごはん', channelId: JOINER }),
    ])

    expect(active.harness.store.countRows('viewer_consent')).toBe(0)
    const published = reactions(active)
    expect(published.length).toBeGreaterThan(0)
    for (const effect of published) expect(effect.actor ?? null).toBeNull()
    const dump = dumpDatabase(active.harness.temp.file)
    expect(dump).not.toContain(JOINER)
    expect(dump).toContain('msg_test_feed')
  })
})

describe('arbiter purge (review round 1, M4)', () => {
  it('drains the deleted references on every writer pass', () => {
    // The deletion happens outside the writer — inside the chat source's ingest
    // transaction, or in the T13 request handler — so the references are handed
    // over as a queue and the writer purges the arbiter with them. Before the
    // fix `forgetVoteScope` and the viewer table had no production caller at all.
    const forgotten = ['ref_test_purge_0000000000000001']
    let drains = 0
    const harness = createEngineHarness({
      identity: {
        takeActor: () => null,
        drainForgotten: () => {
          drains += 1
          const drained = [...forgotten]
          forgotten.length = 0
          return drained
        },
      },
    })
    try {
      harness.engine.start()
      harness.engine.pump()
      expect(drains).toBeGreaterThan(0)
      expect(forgotten).toEqual([])
    } finally {
      harness.dispose()
    }
  })
})
