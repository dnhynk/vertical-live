import { randomBytes } from 'node:crypto'

import {
  ChannelRefSchema,
  ConsentedActorSchema,
  type ConsentedActor,
  type IngestEnvelope,
} from '@vl/contract'

import type { Clock } from '../clock.js'
import type { ConsentDeleteAudit, ConsentDeleteResult } from '../db/consent.js'
import type { ConsentRecord, ConsentSelector } from '../db/types.js'
import { CONSENT_FIELD_KEY, type RetentionConfig, type RetentionField } from '../privacy/config.js'
import { plusDays } from '../privacy/retention.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import { readAuthorIdentity } from './author-details.js'
import { CONSENT_NOTICE_VERSION } from './notice.js'

/**
 * The consent directory: everything that happens to `authorDetails` between the
 * moment a message is read off the wire and the moment the values are gone
 * again (BOARD D-9; spec §7.4, §12.4).
 *
 * One method, `observe`, is called once per received item and does exactly one
 * of four things:
 *
 * 1. `JOIN` → write (or renew) the consent row and issue a `channelRef`;
 * 2. `LEAVE` → delete the consent row immediately and record the deletion;
 * 3. a message from someone who already consented → refresh the stored name and
 *    `lastActiveAt` ([S41] III.E.4.c), and remember the actor **in memory** so
 *    the engine can attach it to that message's on-screen reaction;
 * 4. anything else → drop both values on the spot.
 *
 * Nothing here writes an identity anywhere but `viewer_consent`, and nothing
 * logs one. The returned `ConsentObservation` is what the caller may count and
 * log: it says which of the four happened and nothing about whom.
 *
 * **The in-memory buffer is the only place a name meets a message id.** It is
 * bounded, it is consumed by the engine as it processes each row, and it does
 * not survive a restart — so an effect republished after a crash is anonymous
 * (spec §7.3(7)); the display name is presentation, and the world does not
 * depend on it.
 */

/** The subset of `PersistenceStore` the directory writes through. */
export interface ConsentStorePort {
  upsertConsent(record: ConsentRecord): ConsentRecord
  findConsentByChannelId(channelId: string): ConsentRecord | null
  findConsentByChannelRef(channelRef: string): ConsentRecord | null
  refreshConsent(input: { channelId: string; displayName: string; lastActiveAt: string }): boolean
  deleteConsent(selector: ConsentSelector, audit: ConsentDeleteAudit): ConsentDeleteResult
}

/** What one observed item did to the consent store. Carries no identity. */
export type ConsentObservation =
  /** No author part, no consent decision, or the viewer never opted in. */
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'joined'; readonly renewed: boolean }
  | { readonly kind: 'left'; readonly deleted: boolean }
  | { readonly kind: 'attributed' }

export interface ConsentDirectoryOptions {
  readonly store: ConsentStorePort
  readonly clock: Clock
  /** `config/retention.json`; supplies the deletion window and the audit text. */
  readonly retention: RetentionConfig
  readonly logger?: Logger
  /** Overridable for deterministic tests; production uses 128 random bits. */
  readonly newChannelRef?: () => string
  /** Notice version written on new consent rows. */
  readonly noticeVersion?: string
  /** Bound on the in-memory attribution buffer; see `#remember`. */
  readonly pendingLimit?: number
}

/**
 * How many messages may wait in the attribution buffer.
 *
 * The engine drains the inbox in batches of `engine.drainBatchSize` (200) and
 * the arbiter applies at most `input.window.maxDirectPerWindow` (20) commands
 * per 5-second window, so a few hundred entries covers every message that can
 * still be waiting for its reaction. The bound exists so a stalled writer costs
 * bounded memory, not so it enforces a policy — an evicted entry only means an
 * older message's reaction is shown without a name.
 */
const DEFAULT_PENDING_LIMIT = 1024

/**
 * One memory-only effect of an observation, held back until the write that
 * produced it commits (review round 2, B2).
 *
 * The DB writes of `observe` run inside the caller's transaction and roll back
 * with it; these two do not, because a `Map` has no transaction. Staging them is
 * what makes the memory and the row agree in both directions — a rolled-back
 * attribution is discarded instead of surviving as a name for a row that was
 * never written, and a rolled-back deletion does not forget a viewer who is
 * still stored.
 */
type StagedEffect =
  | { readonly kind: 'remember'; readonly messageId: string; readonly actor: ConsentedActor }
  | { readonly kind: 'forget'; readonly channelRef: string }

export class ConsentDirectory {
  readonly #store: ConsentStorePort
  readonly #clock: Clock
  readonly #retention: RetentionConfig
  readonly #field: RetentionField
  readonly #logger: Logger
  readonly #newChannelRef: () => string
  readonly #noticeVersion: string
  readonly #pendingLimit: number
  /** `messageId -> actor`, in insertion order. Memory only, never persisted. */
  readonly #pending = new Map<string, ConsentedActor>()
  /** References deleted and not yet purged from the arbiter (`drainForgotten`). */
  readonly #forgotten = new Set<string>()
  /** Effects of the write currently in flight; `null` outside `duringCommit`. */
  #staged: StagedEffect[] | null = null

  constructor(options: ConsentDirectoryOptions) {
    const field = options.retention.fields.find((entry) => entry.key === CONSENT_FIELD_KEY)
    if (field === undefined) {
      throw new Error(
        `config/retention.json has no ${CONSENT_FIELD_KEY} field, so a consent deletion could not be recorded (spec §12.4)`,
      )
    }
    this.#store = options.store
    this.#clock = options.clock
    this.#retention = options.retention
    this.#field = field
    this.#logger = options.logger ?? silentLogger
    this.#newChannelRef = options.newChannelRef ?? issueChannelRef
    this.#noticeVersion = options.noticeVersion ?? CONSENT_NOTICE_VERSION
    this.#pendingLimit = options.pendingLimit ?? DEFAULT_PENDING_LIMIT
  }

  /**
   * Handles one received item. `rawItem` is the API object the source read;
   * `envelope` is what the contract adapter made of it — already free of any
   * identity, which is why both are needed here and only here.
   */
  observe(rawItem: unknown, envelope: IngestEnvelope): ConsentObservation {
    if (envelope.validationStatus !== 'valid' || envelope.messageId === null) {
      return ANONYMOUS
    }
    const identity = readAuthorIdentity(rawItem, envelope.sourceShape)
    if (identity === null) return ANONYMOUS

    const consentCommand = envelope.consentCommand ?? null
    if (consentCommand?.name === 'JOIN') {
      return this.#join(identity.channelId, identity.displayName)
    }
    if (consentCommand?.name === 'LEAVE') {
      return this.#leave({ channelId: identity.channelId })
    }

    const now = this.#clock.nowUtcIso()
    const existing = this.#store.findConsentByChannelId(identity.channelId)
    if (existing === null) {
      // Not a consenting viewer: both values go out of scope with this call and
      // the envelope that gets persisted has no field to hold them anyway.
      return ANONYMOUS
    }
    this.#store.refreshConsent({
      channelId: identity.channelId,
      displayName: identity.displayName,
      lastActiveAt: now,
    })
    this.#remember(envelope.messageId, {
      kind: 'consented',
      displayName: identity.displayName,
      channelRef: existing.channelRef,
    })
    return ATTRIBUTED
  }

  /**
   * Runs one inbox write with every memory-only effect of what it observes held
   * back, and applies them only after it returns (review round 2, B2).
   *
   * `observe` is called from inside `commitIngestBatch`'s transaction, so its
   * row writes roll back with the batch. The buffered actors did not: a
   * checkpoint that failed after an attribution left the name in this map for a
   * message the inbox never stored, and once the 30-day sweep deleted that
   * viewer's row the retry of the same `messageId` — now anonymous, because the
   * row is gone — still found the old actor waiting under its id and put a
   * deleted person's name on screen.
   *
   * The window is the callback's lifetime, so staging without an apply or a
   * discard is not expressible. A throw from `write` is a rollback: the staged
   * effects are dropped. Anything the caller does after the SQL commit and
   * before returning (`StateEngine.ingest` notifies its writer) also throws into
   * the discard path, which errs the safe way — a reaction is published without
   * a name rather than with one the store no longer backs.
   */
  duringCommit<T>(write: () => T): T {
    if (this.#staged !== null) {
      throw new Error(
        'ConsentDirectory.duringCommit is already open: one inbox write is one commit boundary, and nesting them would apply an inner batch’s effects to an outer rollback',
      )
    }
    const staged: StagedEffect[] = []
    this.#staged = staged
    let result: T
    try {
      result = write()
    } catch (error) {
      this.#staged = null
      throw error
    }
    this.#staged = null
    for (const effect of staged) {
      if (effect.kind === 'remember') this.#applyRemember(effect.messageId, effect.actor)
      else this.#applyForget(effect.channelRef)
    }
    return result
  }

  /**
   * The actor for a message, if one was remembered — and forgets it, because a
   * message produces one reaction. Returns `null` after a restart, after an
   * eviction, and for every viewer who never consented.
   */
  takeActor(messageId: string): ConsentedActor | null {
    const actor = this.#pending.get(messageId)
    if (actor === undefined) return null
    this.#pending.delete(messageId)
    return actor
  }

  /** Entries waiting to be attributed. Diagnostics only; never a name. */
  get pendingCount(): number {
    return this.#pending.size
  }

  /**
   * Deletes one viewer's record on request, outside the chat path: the T13 user
   * deletion request handler calls this with whichever reference the operator
   * was given (spec §12.4 사용자 삭제 요청).
   */
  forget(
    selector: ConsentSelector,
    reason: 'user_request' | 'consent_revoked',
  ): ConsentDeleteResult {
    return this.#delete(selector, reason)
  }

  /**
   * The same deletion, with an audit row the caller writes: the T13 request
   * handler owns the wording of a request-driven deletion, and this owns what a
   * deletion *is* (review round 1, B2).
   *
   * Before the fix the handler deleted the row straight through the store, which
   * left this directory's buffered display names in place — so `takeActor` still
   * returned the name of someone whose record had just been deleted. Anything
   * that deletes a consent row in a process that has a live directory goes
   * through here.
   */
  deleteWithAudit(selector: ConsentSelector, audit: ConsentDeleteAudit): ConsentDeleteResult {
    // Read the reference before the row is gone: it is what identifies the
    // buffered actors that must be dropped with it, and after the delete there
    // is nothing left to look it up by (that is the point of the delete).
    const channelRef =
      'channelRef' in selector
        ? selector.channelRef
        : (this.#store.findConsentByChannelId(selector.channelId)?.channelRef ?? null)
    const result = this.#store.deleteConsent(selector, audit)
    if (channelRef !== null) this.#forget(channelRef)
    return result
  }

  /**
   * Drops every buffered actor whose consent row is gone, and queues its
   * reference for the arbiter purge (review round 2, B2).
   *
   * `deleteWithAudit` is the deletion boundary for the two paths that name a
   * viewer — `LEAVE` and a user deletion request. The 30-day sweep is the third
   * path and it cannot use that boundary: `RetentionSweeper` deletes by SQL
   * batch, so it never learns which references it removed. This is the same
   * boundary reached from the other end — the buffer is asked which references
   * it still holds, and each one that no longer has a row is dropped.
   *
   * Bounded by the buffer, not by the table: at most `pendingLimit` entries and
   * one indexed lookup per distinct reference among them, which is why the
   * sweeper can call it on every run instead of only after a consent delete.
   *
   * @returns how many buffered actors were dropped. Diagnostics only, never a name.
   */
  forgetDeleted(): number {
    const refs = new Set<string>()
    for (const actor of this.#pending.values()) refs.add(actor.channelRef)
    let dropped = 0
    for (const ref of refs) {
      if (this.#store.findConsentByChannelRef(ref) !== null) continue
      dropped += this.#applyForget(ref)
    }
    if (dropped > 0)
      this.#logger.info('buffered actors dropped with their deleted rows', { dropped })
    return dropped
  }

  /**
   * References deleted since the last call, and clears them.
   *
   * The engine drains this on every writer pass and purges each reference from
   * the input arbiter, which is the only other place a `channelRef` lives
   * (review round 1, M4). It is a queue rather than a callback because every
   * arbiter mutation belongs to the single writer, and this deletion may have
   * happened inside the chat source's ingest transaction.
   */
  drainForgotten(): readonly string[] {
    const refs = [...this.#forgotten]
    this.#forgotten.clear()
    return refs
  }

  #join(channelId: string, displayName: string): ConsentObservation {
    const now = this.#clock.nowUtcIso()
    const existing = this.#store.findConsentByChannelId(channelId)
    const record: ConsentRecord = {
      channelRef: existing?.channelRef ?? ChannelRefSchema.parse(this.#newChannelRef()),
      channelId,
      displayName,
      consentedAt: now,
      lastActiveAt: now,
      noticeVersion: this.#noticeVersion,
    }
    const stored = this.#store.upsertConsent(record)
    // Validated on the way out as well: the renderer only ever sees a value this
    // shape accepted, whatever a row rewritten by hand might contain.
    ConsentedActorSchema.parse({
      kind: 'consented',
      displayName: stored.displayName,
      channelRef: stored.channelRef,
    })
    this.#logger.info('consent recorded', { renewed: existing !== null })
    return { kind: 'joined', renewed: existing !== null }
  }

  #leave(selector: ConsentSelector): ConsentObservation {
    const result = this.#delete(selector, 'consent_revoked')
    return { kind: 'left', deleted: result.rowsDeleted > 0 }
  }

  #delete(
    selector: ConsentSelector,
    reason: 'user_request' | 'consent_revoked',
  ): ConsentDeleteResult {
    const days =
      reason === 'user_request'
        ? this.#retention.revocation.userRequestDeletionDays
        : this.#retention.revocation.clientSideDeletionDays
    const at = this.#clock.nowUtcIso()
    const audit: ConsentDeleteAudit = ({ rowsDeleted }) => ({
      fieldKey: this.#field.key,
      source: this.#field.source,
      purpose: this.#field.purpose,
      policy: 'delete',
      reason,
      allowedPeriodDays: days,
      cutoffAt: null,
      // Recorded as the deadline the obligation had; the deletion itself already
      // ran inside this transaction, well ahead of it (spec §12.4).
      deadlineAt: plusDays(at, days),
      outcome: rowsDeleted > 0 ? 'deleted' : 'no_stored_identifiers',
      rowsDeleted,
      rowsUnprocessed: 0,
      deletedAt: rowsDeleted > 0 ? at : null,
      recordedAt: at,
    })
    const result = this.deleteWithAudit(selector, audit)
    this.#logger.info('consent deleted', { reason, rowsDeleted: result.rowsDeleted })
    return result
  }

  /**
   * Drops every buffered actor for a reference that was just deleted, so a
   * message received a moment before the withdrawal cannot still put the name on
   * screen (D-9 "철회/삭제 명령으로 즉시 삭제").
   */
  #forgetPending(channelRef: string): number {
    let dropped = 0
    for (const [messageId, actor] of this.#pending) {
      if (actor.channelRef !== channelRef) continue
      this.#pending.delete(messageId)
      dropped += 1
    }
    return dropped
  }

  /** Buffers an attribution, or stages it when a write is in flight. */
  #remember(messageId: string, actor: ConsentedActor): void {
    const staged = this.#staged
    if (staged === null) this.#applyRemember(messageId, actor)
    else staged.push({ kind: 'remember', messageId, actor })
  }

  /** Drops a deleted reference, or stages it when a write is in flight. */
  #forget(channelRef: string): void {
    const staged = this.#staged
    if (staged === null) this.#applyForget(channelRef)
    else staged.push({ kind: 'forget', channelRef })
  }

  #applyRemember(messageId: string, actor: ConsentedActor): void {
    this.#pending.set(messageId, actor)
    while (this.#pending.size > this.#pendingLimit) {
      const oldest = this.#pending.keys().next()
      if (oldest.done === true) break
      this.#pending.delete(oldest.value)
    }
  }

  #applyForget(channelRef: string): number {
    const dropped = this.#forgetPending(channelRef)
    this.#forgotten.add(channelRef)
    while (this.#forgotten.size > this.#pendingLimit) {
      const oldest = this.#forgotten.values().next()
      if (oldest.done === true) break
      this.#forgotten.delete(oldest.value)
    }
    return dropped
  }
}

const ANONYMOUS: ConsentObservation = { kind: 'anonymous' }
const ATTRIBUTED: ConsentObservation = { kind: 'attributed' }

/**
 * A fresh opaque reference: `ref_` plus 128 random bits, matching the contract's
 * `CHANNEL_REF_PATTERN`.
 *
 * Random, never derived. §12.4 forbids storing a reversible or stable hash of a
 * channel id just as firmly as the id itself, and a hash would also make two
 * broadcasts' references linkable — which is the cross-broadcast tracking §7.4
 * puts behind the same approval as the name.
 */
export function issueChannelRef(): string {
  return `ref_${randomBytes(16).toString('hex')}`
}
