import type Database from 'better-sqlite3'

import {
  EffectSchema,
  EventKeySchema,
  IngestEnvelopeSchema,
  WorldSnapshotSchema,
  effectiveGiftCount,
  type Effect,
  type IngestEnvelope,
  type ValidationStatus,
  type WorldSnapshot,
} from '@vl/contract'

import { systemClock, type Clock } from '../clock.js'
import { loadDatabaseConfig, type LoadDatabaseConfigOptions } from './config.js'
import {
  EffectNotPublishedError,
  PersistenceInvariantError,
  ProcessedCursorError,
  StateRevisionError,
  UnknownEffectError,
} from './errors.js'
import { migrate } from './migrate.js'
import { openDatabase } from './open.js'
import {
  countRows,
  deleteAllRows,
  deleteExpiredByColumn,
  deleteOrphanedGiftCombos,
  insertRetentionLedger,
  latestInstant,
  listColumnNames,
  listRetentionLedger,
  listTableNames,
  schemaDefinitions,
  tableExists,
  type DeleteAllOptions,
  type DeleteExpiredOptions,
  type DeleteSweepResult,
  type RetentionLedgerEntry,
  type RetentionLedgerFilter,
  type RetentionLedgerRow,
} from './retention.js'
import {
  BROADCAST_STAGE_ORDER,
  type BroadcastAttemptInput,
  type BroadcastAttemptRecord,
  type BroadcastAttemptUpdate,
  type BroadcastMutatingCall,
  type BroadcastStage,
  type BroadcastStrategy,
  type BroadcastTransitionTarget,
} from './types.js'
import type {
  DeadlineRecord,
  InboxInput,
  InboxSubmission,
  EffectMarkResult,
  GiftComboRequest,
  GiftDelta,
  InboxProcessingRecord,
  InboxRow,
  IngestBatchResult,
  IngestInsertResult,
  PaidLedgerRecord,
  PersistedDeadline,
  PersistedEffect,
  RecoveryState,
  SourceCheckpoint,
  SourceCheckpointInput,
  StateTransitionInput,
  StateTransitionRecord,
  StateTransitionResult,
} from './types.js'

/**
 * The authoritative SQL store (spec §10.2): policy-filtered ingest inbox,
 * current snapshot, state revision, processed ingest sequence, deadlines,
 * idempotency and the durable paid-effect outbox.
 *
 * Two transaction boundaries are the point of this class:
 *
 * - `commitIngestBatch` — every envelope of one API response *and* the reconnect
 *   token in one transaction, so a token is never stored ahead of the items it
 *   covers and a poison item never stalls the checkpoint (spec §7.3(2)).
 * - `commitStateTransition` — snapshot, `stateRevision`, `processedIngestSeq`,
 *   the processing record, deadlines, the effect outbox, the paid ledger and the
 *   gift combo maxima in one transaction (spec §7.3(5)).
 *
 * Every write transaction is `IMMEDIATE`: it takes the write lock up front so a
 * blocked writer waits out `busy_timeout` instead of failing an unretryable
 * read-to-write upgrade (`SQLITE_BUSY_SNAPSHOT`).
 */

/** V1 runs one world per supervised host (spec §10.2). */
export const DEFAULT_WORLD_ID = 'default'

export interface OpenStoreOptions {
  readonly file: string
  readonly busyTimeoutMs: number
  /** Injected per spec §10.2; defaults to the system clock. */
  readonly clock?: Clock
  readonly worldId?: string
  /** Apply pending migrations on open. Default true. */
  readonly migrate?: boolean
  readonly migrationsDir?: string
}

interface InboxRowColumns {
  readonly ingest_seq: number
  readonly validation_status: string
  readonly received_at: string
  readonly envelope_json: string
  readonly argument_rejected: number
}

interface CheckpointColumns {
  readonly source_key: string
  readonly live_chat_id: string
  readonly next_page_token: string | null
  readonly last_ingest_seq: number
  readonly updated_at: string
}

interface SnapshotColumns {
  readonly state_revision: number
  readonly processed_ingest_seq: number
  readonly snapshot_json: string
  /** Opaque writer-owned domain state (migration 004); NULL before T8. */
  readonly engine_state_json: string | null
}

interface EffectColumns {
  readonly effect_id: string
  readonly cause_kind: string
  readonly caused_by_event_key: string | null
  readonly cause_deadline_kind: string | null
  readonly cause_deadline_id: string | null
  readonly kind: string
  readonly paid: number
  readonly state_revision: number
  readonly starts_at: string
  readonly ends_at: string
  readonly payload_json: string
  readonly published_at: string | null
  readonly acked_at: string | null
  readonly expired_at: string | null
}

interface BroadcastAttemptColumns {
  readonly attempt_id: string
  readonly strategy: string
  readonly stage: string
  readonly pending_call: string | null
  readonly pending_transition: string | null
  readonly pending_since: string | null
  readonly stream_id: string | null
  readonly stream_title: string
  readonly broadcast_id: string | null
  readonly live_chat_id: string | null
  readonly scheduled_start_time: string
  readonly auto_start: number | null
  readonly last_error_reason: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly closed_at: string | null
}

interface DeadlineColumns {
  readonly id: string
  readonly kind: string
  readonly due_at: string
  readonly policy: string
  readonly payload_json: string
  readonly status: string
}

export class PersistenceStore {
  readonly #db: Database.Database
  readonly #clock: Clock
  readonly #worldId: string

  private constructor(database: Database.Database, clock: Clock, worldId: string) {
    this.#db = database
    this.#clock = clock
    this.#worldId = worldId
  }

  static open(options: OpenStoreOptions): PersistenceStore {
    const clock = options.clock ?? systemClock
    const database = openDatabase({
      file: options.file,
      busyTimeoutMs: options.busyTimeoutMs,
    })
    try {
      if (options.migrate !== false) {
        migrate(database, {
          clock,
          ...(options.migrationsDir === undefined ? {} : { directory: options.migrationsDir }),
        })
      }
    } catch (error) {
      database.close()
      throw error
    }
    return new PersistenceStore(database, clock, options.worldId ?? DEFAULT_WORLD_ID)
  }

  /** Opens the file named by `config/default.json` (`db`) plus env overrides. */
  static fromConfig(
    options: LoadDatabaseConfigOptions & Omit<OpenStoreOptions, 'file' | 'busyTimeoutMs'> = {},
  ): PersistenceStore {
    const { configPath, env, ...storeOptions } = options
    const config = loadDatabaseConfig({
      ...(configPath === undefined ? {} : { configPath }),
      ...(env === undefined ? {} : { env }),
    })
    return PersistenceStore.open({
      file: config.file,
      busyTimeoutMs: config.busyTimeoutMs,
      ...storeOptions,
    })
  }

  close(): void {
    this.#db.close()
  }

  get worldId(): string {
    return this.#worldId
  }

  // ---------------------------------------------------------------- ingest

  /**
   * Commits one API response: every envelope into the append-only inbox and the
   * reconnect checkpoint, in one transaction (spec §7.3(2)).
   *
   * A duplicate event key is not an error — the same message can arrive again
   * after a reconnect. It is reported per envelope so the adapter can publish a
   * duplicate estimate (spec §11 연결 복구) without a second query.
   */
  commitIngestBatch(
    inputs: readonly InboxInput[],
    checkpoint: SourceCheckpointInput,
  ): IngestBatchResult {
    const validated = inputs.map((input) => {
      const submission = toSubmission(input)
      return {
        envelope: IngestEnvelopeSchema.parse(submission.envelope),
        argumentRejected: submission.argumentRejected === true,
      }
    })
    assertNonEmptyString(checkpoint.sourceKey, 'checkpoint.sourceKey')
    assertNonEmptyString(checkpoint.liveChatId, 'checkpoint.liveChatId')

    const insert = this.#db.prepare<
      [string | null, string, string, string, string, string, string, number, string, number],
      { ingest_seq: number }
    >(
      `INSERT INTO ingest_inbox
         (message_id, source, source_shape, broadcast_id, live_chat_id, received_at,
          validation_status, gift_effective_count, envelope_json, argument_rejected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, broadcast_id, message_id, gift_effective_count) DO NOTHING
       RETURNING ingest_seq`,
    )
    const findExisting = this.#db.prepare<[string, string, string, number], { ingest_seq: number }>(
      `SELECT ingest_seq FROM ingest_inbox
        WHERE source = ? AND broadcast_id = ? AND message_id = ? AND gift_effective_count = ?`,
    )

    const commit = this.#db.transaction((): IngestBatchResult => {
      const results: IngestInsertResult[] = []
      for (const { envelope, argumentRejected } of validated) {
        const giftCount = giftEffectiveCountOf(envelope)
        const inserted = insert.get(
          envelope.messageId,
          envelope.source,
          envelope.sourceShape,
          envelope.broadcastId,
          envelope.liveChatId,
          envelope.receivedAt,
          envelope.validationStatus,
          giftCount,
          JSON.stringify(envelope),
          argumentRejected ? 1 : 0,
        )
        if (inserted !== undefined) {
          results.push({
            ingestSeq: inserted.ingest_seq,
            messageId: envelope.messageId,
            duplicate: false,
          })
          continue
        }
        // Only a row with a `message_id` can conflict: the unique index treats
        // NULL ids as distinct, so an id-less item is always inserted.
        const existing = findExisting.get(
          envelope.source,
          envelope.broadcastId,
          envelope.messageId as string,
          giftCount,
        )
        if (existing === undefined) {
          throw new PersistenceInvariantError(
            `inbox insert reported a conflict for ${envelope.source}:${envelope.broadcastId}:${String(envelope.messageId)} but no row exists`,
          )
        }
        results.push({
          ingestSeq: existing.ingest_seq,
          messageId: envelope.messageId,
          duplicate: true,
        })
      }

      const batchMaxSeq = results.reduce((max, result) => Math.max(max, result.ingestSeq), 0)
      const stored = this.#upsertCheckpoint(checkpoint, batchMaxSeq)
      return {
        results,
        insertedCount: results.filter((result) => !result.duplicate).length,
        duplicateCount: results.filter((result) => result.duplicate).length,
        lastIngestSeq: stored.lastIngestSeq,
        checkpoint: stored,
      }
    })
    return commit.immediate()
  }

  /**
   * The recovery drain of spec §7.3(3): unprocessed rows after
   * `processedIngestSeq`, in `ingest_seq` order.
   */
  drainUnprocessed(afterSeq: number, limit: number): InboxRow[] {
    assertNonNegativeInt(afterSeq, 'afterSeq')
    assertPositiveInt(limit, 'limit')
    const rows = this.#db
      .prepare<[number, number], InboxRowColumns>(
        `SELECT ingest_seq, validation_status, received_at, envelope_json, argument_rejected
           FROM ingest_inbox
          WHERE ingest_seq > ? AND processed_at IS NULL
          ORDER BY ingest_seq
          LIMIT ?`,
      )
      .all(afterSeq, limit)
    return rows.map((row) => ({
      ingestSeq: row.ingest_seq,
      validationStatus: row.validation_status as ValidationStatus,
      receivedAt: row.received_at,
      envelope: IngestEnvelopeSchema.parse(JSON.parse(row.envelope_json)),
      argumentRejected: row.argument_rejected === 1,
    }))
  }

  /**
   * The drain a restart must use: rows after the persisted recovery cursor
   * (spec §7.3(3) — "시작·복구 시 source 수신을 재개하기 전에 `processedIngestSeq`
   * 이후의 inbox를 순서대로 drain한다"). Reading the cursor and the rows in one
   * call keeps the two from being taken from different points in time.
   */
  drainFromRecoveryCursor(limit: number): InboxRow[] {
    assertPositiveInt(limit, 'limit')
    const read = this.#db.transaction(() =>
      this.drainUnprocessed(this.#readSnapshotRow()?.processed_ingest_seq ?? 0, limit),
    )
    return read()
  }

  getSourceCheckpoint(sourceKey: string): SourceCheckpoint | null {
    const row = this.#db
      .prepare<[string], CheckpointColumns>(
        `SELECT source_key, live_chat_id, next_page_token, last_ingest_seq, updated_at
           FROM source_checkpoint WHERE source_key = ?`,
      )
      .get(sourceKey)
    return row === undefined ? null : toCheckpoint(row)
  }

  #upsertCheckpoint(input: SourceCheckpointInput, batchMaxSeq: number): SourceCheckpoint {
    // `nowUtcIso()` is read here, after the inbox rows are written: the
    // checkpoint is the last thing this transaction touches.
    const updatedAt = this.#clock.nowUtcIso()
    const row = this.#db
      .prepare<[string, string, string | null, number, string], CheckpointColumns>(
        `INSERT INTO source_checkpoint
           (source_key, live_chat_id, next_page_token, last_ingest_seq, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source_key) DO UPDATE SET
           live_chat_id = excluded.live_chat_id,
           next_page_token = excluded.next_page_token,
           -- Never moves backwards: a replayed batch of older duplicates must not
           -- rewind the sequence the drain resumes from.
           last_ingest_seq = MAX(source_checkpoint.last_ingest_seq, excluded.last_ingest_seq),
           updated_at = excluded.updated_at
         RETURNING source_key, live_chat_id, next_page_token, last_ingest_seq, updated_at`,
      )
      .get(input.sourceKey, input.liveChatId, input.nextPageToken, batchMaxSeq, updatedAt)
    if (row === undefined) {
      throw new PersistenceInvariantError(
        `checkpoint upsert for ${input.sourceKey} returned no row`,
      )
    }
    return toCheckpoint(row)
  }

  // ----------------------------------------------------------------- state

  /**
   * Confirms one state transition in a single transaction (spec §7.3(5)).
   *
   * Rejected before anything is written: a revision that does not advance, a
   * processed sequence that moves backwards, or a snapshot whose own
   * `stateRevision`/`processedIngestSeq` disagree with the commit — a snapshot
   * that disagreed with its own revision would make recovery unsound.
   *
   * Advancing `processedSeq` additionally has to be *earned*: every inbox row in
   * `(stored processedSeq, new processedSeq]` must carry a processing record when
   * the transaction ends, and each supplied record must fall inside that window
   * in ascending order. The cursor is where the drain resumes after a restart
   * (spec §7.3(3)), so a row left below it without a record would never be
   * processed and never be reported — silent loss, which spec §9.2 forbids.
   */
  commitStateTransition(input: StateTransitionInput): StateTransitionResult {
    const snapshot = WorldSnapshotSchema.parse(input.snapshot)
    assertNonNegativeInt(input.revision, 'revision')
    assertNonNegativeInt(input.processedSeq, 'processedSeq')
    if (snapshot.stateRevision !== input.revision) {
      throw new StateRevisionError(
        `snapshot.stateRevision ${String(snapshot.stateRevision)} does not match revision ${String(input.revision)}`,
      )
    }
    if (snapshot.processedIngestSeq !== input.processedSeq) {
      throw new StateRevisionError(
        `snapshot.processedIngestSeq ${String(snapshot.processedIngestSeq)} does not match processedSeq ${String(input.processedSeq)}`,
      )
    }
    const effects = (input.effects ?? []).map((effect) => EffectSchema.parse(effect))
    const transitions = input.transitions ?? []
    const processed = input.processed ?? []
    const giftCombo = input.giftCombo ?? []
    for (const request of giftCombo) {
      assertGiftBaseKey(request)
    }
    // The single writer serializes by `ingestSeq` (spec §7.3(5)), so records that
    // are out of order or repeat a sequence are a writer bug, not a data case.
    processed.forEach((record, index) => {
      assertPositiveInt(record.ingestSeq, 'processed.ingestSeq')
      const previous = processed[index - 1]
      if (previous !== undefined && record.ingestSeq <= previous.ingestSeq) {
        throw new ProcessedCursorError(
          `processed records must be in ascending ingestSeq order: ${String(previous.ingestSeq)} then ${String(record.ingestSeq)}`,
        )
      }
    })

    const commit = this.#db.transaction((): StateTransitionResult => {
      const current = this.#readSnapshotRow()
      if (current !== null && input.revision <= current.state_revision) {
        throw new StateRevisionError(
          `revision must advance: got ${String(input.revision)}, stored ${String(current.state_revision)}`,
        )
      }
      if (current !== null && input.processedSeq < current.processed_ingest_seq) {
        throw new StateRevisionError(
          `processedSeq must not move backwards: got ${String(input.processedSeq)}, stored ${String(current.processed_ingest_seq)}`,
        )
      }
      const previousProcessedSeq = current?.processed_ingest_seq ?? 0
      for (const record of processed) {
        if (record.ingestSeq <= previousProcessedSeq || record.ingestSeq > input.processedSeq) {
          throw new ProcessedCursorError(
            `processing record for ingestSeq ${String(record.ingestSeq)} is outside the cursor window (${String(previousProcessedSeq)}, ${String(input.processedSeq)}]`,
          )
        }
      }
      const previousRevision = current?.state_revision ?? -1
      for (const transition of transitions) {
        if (transition.revision <= previousRevision || transition.revision > input.revision) {
          throw new StateRevisionError(
            `transition revision ${String(transition.revision)} is outside the committed window (${String(previousRevision)}, ${String(input.revision)}]`,
          )
        }
      }
      for (const effect of effects) {
        if (effect.stateRevision > input.revision) {
          throw new StateRevisionError(
            `effect ${effect.effectId} carries stateRevision ${String(effect.stateRevision)} after the committed revision ${String(input.revision)}`,
          )
        }
      }

      this.#writeSnapshot(snapshot, input.revision, input.processedSeq, input.engineState)
      this.#writeTransitions(transitions)
      this.#markProcessed(processed)
      this.#assertCursorEarned(previousProcessedSeq, input.processedSeq)
      this.#writeDeadlines(input.deadlines ?? [])
      const { inserted: effectsInserted, duplicate: effectsDuplicate } = this.#writeEffects(effects)
      const paid = this.#writePaidLedger(input.paidLedger ?? [])
      const giftDeltas = giftCombo.map((request) => this.#applyGiftMax(request))

      return {
        stateRevision: input.revision,
        processedIngestSeq: input.processedSeq,
        giftDeltas,
        effectsInserted,
        effectsDuplicate,
        paidLedgerInserted: paid.inserted,
        paidLedgerDuplicate: paid.duplicate,
      }
    })
    return commit.immediate()
  }

  #readSnapshotRow(): SnapshotColumns | null {
    const row = this.#db
      .prepare<[string], SnapshotColumns>(
        `SELECT state_revision, processed_ingest_seq, snapshot_json, engine_state_json
           FROM world_snapshot WHERE world_id = ?`,
      )
      .get(this.#worldId)
    return row ?? null
  }

  #writeSnapshot(
    snapshot: WorldSnapshot,
    revision: number,
    processedSeq: number,
    engineState: unknown,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO world_snapshot
           (world_id, state_revision, processed_ingest_seq, snapshot_json, engine_state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (world_id) DO UPDATE SET
           state_revision = excluded.state_revision,
           processed_ingest_seq = excluded.processed_ingest_seq,
           snapshot_json = excluded.snapshot_json,
           engine_state_json = excluded.engine_state_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.#worldId,
        revision,
        processedSeq,
        JSON.stringify(snapshot),
        engineState === undefined ? null : JSON.stringify(engineState),
        this.#clock.nowUtcIso(),
      )
  }

  #writeTransitions(transitions: readonly StateTransitionRecord[]): void {
    const insert = this.#db.prepare(
      `INSERT INTO state_transitions (revision, caused_by_event_key, kind, at)
       VALUES (?, ?, ?, ?)`,
    )
    for (const transition of transitions) {
      assertNonEmptyString(transition.kind, 'transition.kind')
      insert.run(transition.revision, transition.causedByEventKey, transition.kind, transition.at)
    }
  }

  #markProcessed(records: readonly InboxProcessingRecord[]): void {
    const update = this.#db.prepare(
      `UPDATE ingest_inbox SET processed_at = ?, processing_result = ?
        WHERE ingest_seq = ? AND processed_at IS NULL`,
    )
    for (const record of records) {
      assertPositiveInt(record.ingestSeq, 'processed.ingestSeq')
      assertNonEmptyString(record.result, 'processed.result')
      const changes = update.run(
        record.at ?? this.#clock.nowUtcIso(),
        record.result,
        record.ingestSeq,
      ).changes
      if (changes === 0) {
        // Either the row does not exist or it was already marked. Both mean the
        // writer's view of the inbox is stale, which must not be committed.
        throw new PersistenceInvariantError(
          `inbox row ${String(record.ingestSeq)} is missing or already processed`,
        )
      }
    }
  }

  /**
   * The cursor may only pass inbox rows that are recorded as processed.
   *
   * Checked by reading the inbox back rather than by comparing the input to the
   * expected set: rows can also have been marked in an earlier commit, and the
   * question that matters for recovery is only whether anything below the new
   * cursor is still unprocessed. A sequence with no row at all is fine — it was
   * burnt by a rolled-back transaction or removed by retention (T13).
   */
  #assertCursorEarned(previousProcessedSeq: number, processedSeq: number): void {
    if (processedSeq <= previousProcessedSeq) return
    const stranded = this.#db
      .prepare<[number, number], { ingest_seq: number }>(
        `SELECT ingest_seq FROM ingest_inbox
          WHERE ingest_seq > ? AND ingest_seq <= ? AND processed_at IS NULL
          ORDER BY ingest_seq
          LIMIT 6`,
      )
      .all(previousProcessedSeq, processedSeq)
    if (stranded.length === 0) return

    const listed = stranded.slice(0, 5).map((row) => String(row.ingest_seq))
    const suffix = stranded.length > 5 ? ', …' : ''
    throw new ProcessedCursorError(
      `processedIngestSeq ${String(processedSeq)} would move the recovery cursor past unprocessed inbox rows ${listed.join(', ')}${suffix} ` +
        `(stored cursor ${String(previousProcessedSeq)}); commit a processing record for every row in the window (spec §7.3(3)(5))`,
    )
  }

  #writeDeadlines(deadlines: readonly DeadlineRecord[]): void {
    const upsert = this.#db.prepare(
      `INSERT INTO deadlines (id, kind, due_at, policy, payload_json, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         kind = excluded.kind,
         due_at = excluded.due_at,
         policy = excluded.policy,
         payload_json = excluded.payload_json,
         status = excluded.status`,
    )
    for (const deadline of deadlines) {
      assertNonEmptyString(deadline.id, 'deadline.id')
      assertNonEmptyString(deadline.kind, 'deadline.kind')
      upsert.run(
        deadline.id,
        deadline.kind,
        deadline.dueAt,
        deadline.policy,
        // A payload `JSON.stringify` cannot serialize (a BigInt, a circular
        // reference) throws here and rolls the whole transition back.
        JSON.stringify(deadline.payload ?? null),
        deadline.status,
      )
    }
  }

  #writeEffects(effects: readonly Effect[]): { inserted: string[]; duplicate: string[] } {
    const insert = this.#db.prepare<
      [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
        number,
        number,
        string,
        string,
        string,
      ],
      { effect_id: string }
    >(
      `INSERT INTO effect_outbox
         (effect_id, cause_kind, caused_by_event_key, cause_deadline_kind, cause_deadline_id,
          kind, paid, state_revision, starts_at, ends_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (effect_id) DO NOTHING
       RETURNING effect_id`,
    )
    const inserted: string[] = []
    const duplicate: string[] = []
    for (const effect of effects) {
      const row = insert.get(
        effect.effectId,
        effect.cause.kind,
        effect.causedByEventKey,
        effect.cause.kind === 'deadline' ? effect.cause.deadlineKind : null,
        effect.cause.kind === 'deadline' ? (effect.cause.deadlineId ?? null) : null,
        effect.kind,
        effect.paid ? 1 : 0,
        effect.stateRevision,
        effect.startsAt,
        effect.endsAt,
        JSON.stringify(effect.payload),
      )
      if (row === undefined) {
        duplicate.push(effect.effectId)
      } else {
        inserted.push(effect.effectId)
      }
    }
    return { inserted, duplicate }
  }

  #writePaidLedger(records: readonly PaidLedgerRecord[]): {
    inserted: string[]
    duplicate: string[]
  } {
    const insert = this.#db.prepare<
      [string, string, number | null, string | null, number | null, number | null, string],
      { event_key: string }
    >(
      `INSERT INTO paid_ledger
         (event_key, kind, amount_micros, currency, tier, jewels, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING event_key`,
    )
    const inserted: string[] = []
    const duplicate: string[] = []
    for (const record of records) {
      EventKeySchema.parse(record.eventKey)
      const row = insert.get(
        record.eventKey,
        record.kind,
        record.amountMicros,
        record.currency,
        record.tier,
        record.jewels,
        record.appliedAt,
      )
      if (row === undefined) {
        duplicate.push(record.eventKey)
      } else {
        inserted.push(record.eventKey)
      }
    }
    return { inserted, duplicate }
  }

  /**
   * Whether this paid event was already applied. The ledger's primary key makes
   * the *write* idempotent; the writer needs the same answer one step earlier so
   * it does not stage a second thanks for an event it already acknowledged
   * (spec §11 유료 무결성). Single writer, so a read here and the commit that
   * follows cannot interleave with another writer.
   */
  hasPaidLedgerEntry(eventKey: string): boolean {
    const row = this.#db
      .prepare<[string], { event_key: string }>(
        'SELECT event_key FROM paid_ledger WHERE event_key = ?',
      )
      .get(eventKey)
    return row !== undefined
  }

  // ------------------------------------------------------------ gift combo

  /**
   * Folds one gift combo step into the stored maximum and returns what the world
   * should apply: `delta = max(0, effectiveCount - storedMax)`, with `storedMax`
   * never decreasing (spec §7.4). A late or reordered lower count yields 0.
   */
  upsertGiftMax(baseKey: string, effectiveCount: number): GiftDelta {
    const request: GiftComboRequest = { baseKey, effectiveCount }
    assertGiftBaseKey(request)
    const apply = this.#db.transaction(() => this.#applyGiftMax(request))
    return apply.immediate()
  }

  #applyGiftMax(request: GiftComboRequest): GiftDelta {
    const existing = this.#db
      .prepare<[string], { stored_max: number }>(
        'SELECT stored_max FROM gift_combo WHERE base_key = ?',
      )
      .get(request.baseKey)
    const previousMax = existing?.stored_max ?? 0
    const storedMax = Math.max(previousMax, request.effectiveCount)
    if (storedMax !== previousMax || existing === undefined) {
      this.#db
        .prepare(
          `INSERT INTO gift_combo (base_key, stored_max) VALUES (?, ?)
           ON CONFLICT (base_key) DO UPDATE SET stored_max = excluded.stored_max`,
        )
        .run(request.baseKey, storedMax)
    }
    return {
      baseKey: request.baseKey,
      effectiveCount: request.effectiveCount,
      previousMax,
      storedMax,
      delta: Math.max(0, request.effectiveCount - previousMax),
    }
  }

  getGiftStoredMax(baseKey: string): number {
    const row = this.#db
      .prepare<[string], { stored_max: number }>(
        'SELECT stored_max FROM gift_combo WHERE base_key = ?',
      )
      .get(baseKey)
    return row?.stored_max ?? 0
  }

  // ---------------------------------------------------------- effect outbox

  /** Records that the snapshot/effect was put on the wire (spec §7.3(6)). */
  markEffectPublished(effectId: string, at: string = this.#clock.nowUtcIso()): EffectMarkResult {
    const mark = this.#db.transaction((): EffectMarkResult => {
      const row = this.#requireEffectRow(effectId)
      if (row.published_at !== null) return 'already_published'
      this.#db
        .prepare('UPDATE effect_outbox SET published_at = ? WHERE effect_id = ?')
        .run(at, effectId)
      return 'recorded'
    })
    return mark.immediate()
  }

  /**
   * Records the renderer ACK for an effect it applied to a real frame
   * (spec §7.3(7)). An ACK for an effect that was never published is rejected:
   * the renderer cannot have applied something the server did not send.
   *
   * An ACK after the expiry window is still recorded — the ACK is ground truth
   * that the effect ran; `expired_at` is only the server's own timeout note.
   */
  markEffectAcked(effectId: string, at: string = this.#clock.nowUtcIso()): EffectMarkResult {
    const mark = this.#db.transaction((): EffectMarkResult => {
      const row = this.#requireEffectRow(effectId)
      if (row.published_at === null) throw new EffectNotPublishedError(effectId)
      if (row.acked_at !== null) return 'already_acked'
      this.#db
        .prepare('UPDATE effect_outbox SET acked_at = ? WHERE effect_id = ?')
        .run(at, effectId)
      return 'recorded'
    })
    return mark.immediate()
  }

  /**
   * Records that the effect's window passed without an ACK (spec §7.3(7), §9.2:
   * the substitute audit staging runs once). An already-acked effect is left
   * alone — it did run.
   */
  markEffectExpired(effectId: string, at: string = this.#clock.nowUtcIso()): EffectMarkResult {
    const mark = this.#db.transaction((): EffectMarkResult => {
      const row = this.#requireEffectRow(effectId)
      if (row.acked_at !== null) return 'already_acked'
      if (row.expired_at !== null) return 'already_expired'
      this.#db
        .prepare('UPDATE effect_outbox SET expired_at = ? WHERE effect_id = ?')
        .run(at, effectId)
      return 'recorded'
    })
    return mark.immediate()
  }

  getEffect(effectId: string): PersistedEffect | null {
    const row = this.#db
      .prepare<[string], EffectColumns>(`${EFFECT_COLUMNS} WHERE effect_id = ?`)
      .get(effectId)
    return row === undefined ? null : toPersistedEffect(row)
  }

  #requireEffectRow(effectId: string): EffectColumns {
    const row = this.#db
      .prepare<[string], EffectColumns>(`${EFFECT_COLUMNS} WHERE effect_id = ?`)
      .get(effectId)
    if (row === undefined) throw new UnknownEffectError(effectId)
    return row
  }

  // --------------------------------------------------------------- recovery

  /**
   * Everything a restart needs before source reception resumes (spec §7.3(3),
   * §11 상태 복구): the last snapshot with its revision and processed sequence,
   * the effects that are still open, the deadlines already due, and the reconnect
   * checkpoints.
   */
  loadRecoveryState(now: string = this.#clock.nowUtcIso()): RecoveryState {
    const row = this.#readSnapshotRow()
    return {
      snapshot: row === null ? null : WorldSnapshotSchema.parse(JSON.parse(row.snapshot_json)),
      stateRevision: row?.state_revision ?? 0,
      processedIngestSeq: row?.processed_ingest_seq ?? 0,
      engineState:
        row?.engine_state_json === undefined || row.engine_state_json === null
          ? null
          : JSON.parse(row.engine_state_json),
      unackedEffects: this.listUnackedEffects(),
      dueDeadlines: this.listPendingDeadlines(now),
      checkpoints: this.listSourceCheckpoints(),
    }
  }

  /** Committed effects that are neither acked nor expired, oldest revision first. */
  listUnackedEffects(): PersistedEffect[] {
    const rows = this.#db
      .prepare<[], EffectColumns>(
        `${EFFECT_COLUMNS} WHERE acked_at IS NULL AND expired_at IS NULL
          ORDER BY state_revision, effect_id`,
      )
      .all()
    return rows.map(toPersistedEffect)
  }

  /**
   * Pending deadlines, optionally only those already due at `dueBefore`. The
   * replay/coalesce/skip policy travels with each row; applying it is T8's job
   * (spec §10.2).
   */
  listPendingDeadlines(dueBefore?: string): PersistedDeadline[] {
    const rows =
      dueBefore === undefined
        ? this.#db
            .prepare<[], DeadlineColumns>(
              `${DEADLINE_COLUMNS} WHERE status = 'pending' ORDER BY due_at, id`,
            )
            .all()
        : this.#db
            .prepare<[string], DeadlineColumns>(
              `${DEADLINE_COLUMNS} WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id`,
            )
            .all(dueBefore)
    return rows.map(toPersistedDeadline)
  }

  listSourceCheckpoints(): SourceCheckpoint[] {
    const rows = this.#db
      .prepare<[], CheckpointColumns>(
        `SELECT source_key, live_chat_id, next_page_token, last_ingest_seq, updated_at
           FROM source_checkpoint ORDER BY source_key`,
      )
      .all()
    return rows.map(toCheckpoint)
  }

  // -------------------------------------------------------------- retention
  //
  // T13's surface (spec §12.4). The statements live in `db/retention.ts`; these
  // methods exist so the retention job goes through the single store interface
  // instead of opening a second connection to the same WAL file.

  /** Every table in the open schema, including SQLite's own bookkeeping ones. */
  listTables(): string[] {
    return listTableNames(this.#db)
  }

  /** Column names of one table; empty when the table does not exist. */
  listColumns(table: string): string[] {
    return listColumnNames(this.#db, table)
  }

  /**
   * The whole schema as `table -> columns`. `config/retention.json` is checked
   * against this, so a field map that no longer matches the tables it describes
   * is a startup error rather than a silent drift (review round 1, M1).
   */
  describeSchema(): Map<string, readonly string[]> {
    return new Map(
      listTableNames(this.#db).map((table) => [table, listColumnNames(this.#db, table)]),
    )
  }

  hasTable(table: string): boolean {
    return tableExists(this.#db, table)
  }

  /** `CREATE` text of every schema object — used by the identity-column audit. */
  listSchemaDefinitions(): { name: string; sql: string }[] {
    return schemaDefinitions(this.#db)
  }

  countRows(table: string): number {
    return countRows(this.#db, table)
  }

  /** Highest value of an instant column, i.e. when the table was last written. */
  latestInstant(table: string, column: string): string | null {
    return latestInstant(this.#db, table, column)
  }

  deleteExpiredByColumn(options: DeleteExpiredOptions): DeleteSweepResult {
    return deleteExpiredByColumn(this.#db, options)
  }

  deleteAllRows(options: DeleteAllOptions): DeleteSweepResult {
    return deleteAllRows(this.#db, options)
  }

  deleteOrphanedGiftCombos(options: Omit<DeleteAllOptions, 'table'>): DeleteSweepResult {
    return deleteOrphanedGiftCombos(this.#db, options)
  }

  /**
   * Appends one retention audit row and returns its `entry_id`.
   *
   * Only for outcomes that deleted nothing (`nothing_expired`, `reverified`,
   * `table_absent`, `no_stored_identifiers`, `failed`). Evidence for an actual
   * deletion is written inside the deleting transaction by the methods above, so
   * it cannot be lost on its own (review round 1, B1).
   */
  recordRetention(entry: RetentionLedgerEntry): number {
    return insertRetentionLedger(this.#db, entry)
  }

  listRetentionLedger(filter: RetentionLedgerFilter = {}): RetentionLedgerRow[] {
    return listRetentionLedger(this.#db, filter)
  }

  // ------------------------------------------------------- broadcast resources

  /**
   * Records the intent to bring one broadcast up, before any API call
   * (spec §9.1). The reconcile keys (`streamTitle`, `scheduledStartTime`) are
   * fixed here precisely because a retry has to look for the *same* resource.
   */
  beginBroadcastAttempt(input: BroadcastAttemptInput): BroadcastAttemptRecord {
    assertNonEmptyString(input.attemptId, 'attemptId')
    assertNonEmptyString(input.streamTitle, 'streamTitle')
    assertNonEmptyString(input.scheduledStartTime, 'scheduledStartTime')
    const now = this.#clock.nowUtcIso()
    this.#db
      .prepare(
        `INSERT INTO broadcast_resources
           (attempt_id, strategy, stage, stream_title, scheduled_start_time, created_at, updated_at)
         VALUES (?, ?, 'planned', ?, ?, ?, ?)`,
      )
      .run(input.attemptId, input.strategy, input.streamTitle, input.scheduledStartTime, now, now)
    return this.#requireBroadcastAttempt(input.attemptId)
  }

  /**
   * Marks a mutating call as in flight. Written *before* the request leaves the
   * process, so a crash or a timeout leaves the uncertainty on disk and the next
   * run reconciles instead of retrying blindly (spec §9.1).
   */
  markBroadcastCallPending(
    attemptId: string,
    call: BroadcastMutatingCall,
    transitionTarget?: BroadcastTransitionTarget,
  ): BroadcastAttemptRecord {
    const current = this.#requireBroadcastAttempt(attemptId)
    if (current.closedAt !== null) {
      throw new PersistenceInvariantError(
        `broadcast attempt ${attemptId} is closed; a closed attempt makes no more calls`,
      )
    }
    if (current.pendingCall !== null && current.pendingCall !== call) {
      throw new PersistenceInvariantError(
        `broadcast attempt ${attemptId} still has ${current.pendingCall} in flight; resolve it before calling ${call}`,
      )
    }
    // The target is what makes a resumed transition reconcile readable, so it is
    // required rather than optional for that call (review round 1, B4).
    if (call === 'liveBroadcasts.transition' && transitionTarget === undefined) {
      throw new PersistenceInvariantError(
        `broadcast attempt ${attemptId}: a pending ${call} must record its target status`,
      )
    }
    if (call !== 'liveBroadcasts.transition' && transitionTarget !== undefined) {
      throw new PersistenceInvariantError(
        `broadcast attempt ${attemptId}: ${call} has no transition target`,
      )
    }
    const now = this.#clock.nowUtcIso()
    this.#db
      .prepare(
        `UPDATE broadcast_resources
            SET pending_call = ?, pending_transition = ?, pending_since = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(call, transitionTarget ?? null, now, now, attemptId)
    return this.#requireBroadcastAttempt(attemptId)
  }

  /**
   * Records what a resolved call established and clears the pending marker. Used
   * for a success, for a definitive rejection, and for a reconcile that found the
   * call had (or had not) been applied — in every one of those cases the outcome
   * is no longer unknown.
   */
  recordBroadcastCallResult(
    attemptId: string,
    update: BroadcastAttemptUpdate = {},
  ): BroadcastAttemptRecord {
    return this.#updateBroadcastAttempt(attemptId, update, { clearPending: true })
  }

  /** Same as `recordBroadcastCallResult` but leaves an in-flight call pending. */
  updateBroadcastAttempt(
    attemptId: string,
    update: BroadcastAttemptUpdate,
  ): BroadcastAttemptRecord {
    return this.#updateBroadcastAttempt(attemptId, update, { clearPending: false })
  }

  /**
   * Ends an attempt. `complete` for a broadcast that finished, `abandoned` for one
   * this host gave up on (a limit it could not recover from, spec §9.1). The row
   * stays: it is the audit trail of what was created at YouTube.
   */
  closeBroadcastAttempt(
    attemptId: string,
    stage: 'complete' | 'abandoned',
    reason?: string,
  ): BroadcastAttemptRecord {
    const current = this.#requireBroadcastAttempt(attemptId)
    if (current.closedAt !== null) {
      return current
    }
    this.#db
      .prepare(
        `UPDATE broadcast_resources
            SET stage = ?, pending_call = NULL, pending_transition = NULL, pending_since = NULL,
                last_error_reason = COALESCE(?, last_error_reason),
                closed_at = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(stage, reason ?? null, this.#clock.nowUtcIso(), this.#clock.nowUtcIso(), attemptId)
    return this.#requireBroadcastAttempt(attemptId)
  }

  getBroadcastAttempt(attemptId: string): BroadcastAttemptRecord | null {
    const row = this.#db
      .prepare<[string], BroadcastAttemptColumns>(`${BROADCAST_COLUMNS} WHERE attempt_id = ?`)
      .get(attemptId)
    return row === undefined ? null : toBroadcastAttempt(row)
  }

  /** The newest attempt that has not been closed — what a restart resumes. */
  findOpenBroadcastAttempt(): BroadcastAttemptRecord | null {
    const row = this.#db
      .prepare<[], BroadcastAttemptColumns>(
        `${BROADCAST_COLUMNS} WHERE closed_at IS NULL ORDER BY created_at DESC, attempt_id DESC LIMIT 1`,
      )
      .get()
    return row === undefined ? null : toBroadcastAttempt(row)
  }

  /** Newest first. Used by `/health` and by the rolling-experiment report. */
  listBroadcastAttempts(limit = 50): BroadcastAttemptRecord[] {
    assertPositiveInt(limit, 'limit')
    const rows = this.#db
      .prepare<[number], BroadcastAttemptColumns>(
        `${BROADCAST_COLUMNS} ORDER BY created_at DESC, attempt_id DESC LIMIT ?`,
      )
      .all(limit)
    return rows.map(toBroadcastAttempt)
  }

  #updateBroadcastAttempt(
    attemptId: string,
    update: BroadcastAttemptUpdate,
    options: { clearPending: boolean },
  ): BroadcastAttemptRecord {
    const current = this.#requireBroadcastAttempt(attemptId)
    if (update.stage !== undefined) {
      assertBroadcastStageAdvances(current.stage, update.stage, attemptId)
    }
    // Every external id is write-once: the same attempt pointing at a second
    // broadcast or stream would make the audit trail a guess.
    assertBroadcastIdStable(current.streamId, update.streamId, attemptId, 'streamId')
    assertBroadcastIdStable(current.broadcastId, update.broadcastId, attemptId, 'broadcastId')
    assertBroadcastIdStable(current.liveChatId, update.liveChatId, attemptId, 'liveChatId')

    const now = this.#clock.nowUtcIso()
    this.#db
      .prepare(
        `UPDATE broadcast_resources
            SET stage = COALESCE(?, stage),
                stream_id = COALESCE(?, stream_id),
                broadcast_id = COALESCE(?, broadcast_id),
                live_chat_id = COALESCE(?, live_chat_id),
                scheduled_start_time = COALESCE(?, scheduled_start_time),
                auto_start = COALESCE(?, auto_start),
                last_error_reason = CASE WHEN ? THEN ? ELSE last_error_reason END,
                pending_call = CASE WHEN ? THEN NULL ELSE pending_call END,
                pending_transition = CASE WHEN ? THEN NULL ELSE pending_transition END,
                pending_since = CASE WHEN ? THEN NULL ELSE pending_since END,
                updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        update.stage ?? null,
        update.streamId ?? null,
        update.broadcastId ?? null,
        update.liveChatId ?? null,
        update.scheduledStartTime ?? null,
        update.autoStart === undefined ? null : update.autoStart ? 1 : 0,
        update.lastErrorReason === undefined ? 0 : 1,
        update.lastErrorReason ?? null,
        options.clearPending ? 1 : 0,
        options.clearPending ? 1 : 0,
        options.clearPending ? 1 : 0,
        now,
        attemptId,
      )
    return this.#requireBroadcastAttempt(attemptId)
  }

  #requireBroadcastAttempt(attemptId: string): BroadcastAttemptRecord {
    const record = this.getBroadcastAttempt(attemptId)
    if (record === null) {
      throw new PersistenceInvariantError(`unknown broadcast attempt ${attemptId}`)
    }
    return record
  }
}

const EFFECT_COLUMNS = `SELECT effect_id, cause_kind, caused_by_event_key, cause_deadline_kind,
         cause_deadline_id, kind, paid, state_revision,
         starts_at, ends_at, payload_json, published_at, acked_at, expired_at
    FROM effect_outbox`

const DEADLINE_COLUMNS = `SELECT id, kind, due_at, policy, payload_json, status FROM deadlines`

const BROADCAST_COLUMNS = `SELECT attempt_id, strategy, stage, pending_call, pending_transition, pending_since,
         stream_id, stream_title, broadcast_id, live_chat_id, scheduled_start_time,
         auto_start, last_error_reason, created_at, updated_at, closed_at
    FROM broadcast_resources`

function toBroadcastAttempt(row: BroadcastAttemptColumns): BroadcastAttemptRecord {
  return {
    attemptId: row.attempt_id,
    strategy: row.strategy as BroadcastStrategy,
    stage: row.stage as BroadcastStage,
    pendingCall: row.pending_call as BroadcastMutatingCall | null,
    pendingTransition: row.pending_transition as BroadcastTransitionTarget | null,
    pendingSince: row.pending_since,
    streamId: row.stream_id,
    streamTitle: row.stream_title,
    broadcastId: row.broadcast_id,
    liveChatId: row.live_chat_id,
    scheduledStartTime: row.scheduled_start_time,
    autoStart: row.auto_start === null ? null : row.auto_start === 1,
    lastErrorReason: row.last_error_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

/**
 * The stage is the durable record of what has already been done at YouTube, so it
 * only ever moves forwards. `abandoned` is reachable from anywhere: giving up is
 * always allowed (spec §9.1 safe stop).
 */
function assertBroadcastStageAdvances(
  current: BroadcastStage,
  next: BroadcastStage,
  attemptId: string,
): void {
  if (next === 'abandoned' || next === current) {
    return
  }
  const currentIndex = BROADCAST_STAGE_ORDER.indexOf(current)
  const nextIndex = BROADCAST_STAGE_ORDER.indexOf(next)
  if (currentIndex === -1 || nextIndex <= currentIndex) {
    throw new PersistenceInvariantError(
      `broadcast attempt ${attemptId} cannot move from stage ${current} to ${next}`,
    )
  }
}

function assertBroadcastIdStable(
  current: string | null,
  next: string | undefined,
  attemptId: string,
  label: string,
): void {
  if (next !== undefined && current !== null && current !== next) {
    throw new PersistenceInvariantError(
      `broadcast attempt ${attemptId} already points at ${label} ${current}; refusing to repoint it at ${next}`,
    )
  }
}

/**
 * 0 for anything that is not a well-formed gift, so the unique index stays NOT
 * NULL; `effectiveCount` for a gift (spec §7.4).
 */
function giftEffectiveCountOf(envelope: IngestEnvelope): number {
  if (envelope.validationStatus !== 'valid' || envelope.kind !== 'GIFT') return 0
  return effectiveGiftCount(envelope.payment?.comboCount ?? null)
}

/** A bare envelope declares nothing; a submission declares what was filtered. */
function toSubmission(input: InboxInput): InboxSubmission {
  return 'envelope' in input ? input : { envelope: input }
}

function toCheckpoint(row: CheckpointColumns): SourceCheckpoint {
  return {
    sourceKey: row.source_key,
    liveChatId: row.live_chat_id,
    nextPageToken: row.next_page_token,
    lastIngestSeq: row.last_ingest_seq,
    updatedAt: row.updated_at,
  }
}

function toPersistedEffect(row: EffectColumns): PersistedEffect {
  return {
    effect: EffectSchema.parse({
      schemaVersion: 1,
      effectId: row.effect_id,
      cause: toEffectCause(row),
      causedByEventKey: row.caused_by_event_key,
      kind: row.kind,
      paid: row.paid === 1,
      stateRevision: row.state_revision,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      payload: JSON.parse(row.payload_json),
    }),
    publishedAt: row.published_at,
    ackedAt: row.acked_at,
    expiredAt: row.expired_at,
  }
}

/**
 * Rebuilds the `EffectCause` branch the row stored (BOARD A-17). The table's
 * CHECK constraints already guarantee the members of the branch are present, and
 * `EffectSchema.parse` re-checks the cause rules on the way out.
 */
function toEffectCause(row: EffectColumns): unknown {
  if (row.cause_kind === 'deadline') {
    return {
      kind: 'deadline',
      deadlineKind: row.cause_deadline_kind,
      ...(row.cause_deadline_id === null ? {} : { deadlineId: row.cause_deadline_id }),
    }
  }
  return { kind: 'event', eventKey: row.caused_by_event_key }
}

function toPersistedDeadline(row: DeadlineColumns): PersistedDeadline {
  return {
    id: row.id,
    kind: row.kind,
    dueAt: row.due_at,
    policy: row.policy as PersistedDeadline['policy'],
    payload: JSON.parse(row.payload_json),
    status: row.status as PersistedDeadline['status'],
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new PersistenceInvariantError(`${label} must be a non-empty string`)
  }
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new PersistenceInvariantError(`${label} must be a non-negative integer`)
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PersistenceInvariantError(`${label} must be a positive integer`)
  }
}

/**
 * The gift maximum is keyed by the *base* event key. Passing a full gift key
 * would store a separate maximum per combo step, which is exactly what the
 * non-decreasing maximum exists to prevent (spec §7.4).
 */
function assertGiftBaseKey(request: GiftComboRequest): void {
  EventKeySchema.parse(request.baseKey)
  if (request.baseKey.includes(':gift:')) {
    throw new PersistenceInvariantError(
      `gift base key must not carry the :gift: suffix: ${request.baseKey}`,
    )
  }
  assertPositiveInt(request.effectiveCount, 'effectiveCount')
}
