import {
  CanonicalEventSchema,
  eventKeyForEnvelope,
  effectiveGiftCount,
  sourceDataExpiresAt,
  type BroadcastLifecycle,
  type CanonicalEvent,
  type CommandName,
  type Effect,
  type InputMode,
  type PaidEventKind,
  type ValidIngestEnvelope,
  type WorldSnapshot,
} from '@vl/contract'

import type { Clock, TimerHandle } from '../clock.js'
import { EffectNotPublishedError, UnknownEffectError } from '../db/errors.js'
import type { PersistenceStore } from '../db/store.js'
import type {
  InboxProcessingRecord,
  InboxRow,
  PaidLedgerRecord,
  PersistedEffect,
} from '../db/types.js'
import { InputArbiter } from '../input/arbiter.js'
import { loadInputConfig, type InputConfig } from '../input/config.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import { paidEventKindOf } from '../world/paid.js'
import {
  initialWorldState,
  pendingDeadlines,
  recoverDeadlines,
  step,
  stepRngFor,
} from '../world/reducer.js'
import { toMillis } from '../world/time.js'
import type {
  EffectDraft,
  ScheduledDeadline,
  StepInput,
  WorldState,
  WorldTransition,
} from '../world/types.js'
import { loadEngineConfig, type EngineRuntimeConfig } from './config.js'
import { deadlineRowIdOf, deadlineTableDiff } from './deadlines.js'
import { assembleEffect } from './effects.js'
import { EngineMetrics, type EngineMetricsSnapshot } from './metrics.js'
import { buildSnapshot } from './snapshot.js'
import { parseEngineState, serializeEngineState } from './state.js'

/**
 * The single writer of spec §7.3(5).
 *
 * Every change to the world happens here, in one loop, in one order: inbox rows
 * by `ingestSeq` and due deadlines by `dueAt`, merged on time. One input becomes
 * one `commitStateTransition` — snapshot, revision, cursor, processing records,
 * schedule, effect outbox, paid ledger and gift maxima in a single transaction —
 * and only then is anything published (spec §7.3(6)).
 *
 * The ordering that matters for correctness, and why:
 *
 * 1. **Dedupe before the world sees the event.** The paid ledger's primary key
 *    and the gift maximum are read first, so a replayed Super Chat never reaches
 *    the reducer and a combo step that adds nothing stages nothing (spec §7.4,
 *    §11 유료 무결성).
 * 2. **Commit before publish.** A crash between the two leaves a committed effect
 *    that is not acked, which start-up republishes; the reverse order would show
 *    a viewer something the world never committed (spec §9.2 유료).
 * 3. **The cursor never passes an unresolved row.** Aggregated commands are held
 *    until their window closes, and the recovery cursor stays below them, so a
 *    restart re-drains them instead of losing the contributions (spec §6.4, §9.2).
 */

/**
 * Runaway guard for one pass of the writer loop. Reached only if a deadline kind
 * stopped leaving the due set, which is a bug rather than a load condition — a
 * whole day of the current content produces a few thousand steps.
 */
const MAX_STEPS_PER_PASS = 100_000

export type InputHealth = 'ok' | 'degraded' | 'unknown'

/** Where committed state goes. The WS hub implements it; tests substitute it. */
export interface EnginePublisher {
  /** Renderers currently attached. Zero is a degraded condition (spec §9.2). */
  readonly rendererCount: number
  publishSnapshot(snapshot: WorldSnapshot): void
  publishEffect(effect: Effect): void
}

export const nullPublisher: EnginePublisher = {
  rendererCount: 0,
  publishSnapshot() {},
  publishEffect() {},
}

export interface StateEngineOptions {
  readonly store: PersistenceStore
  readonly clock: Clock
  readonly config?: EngineRuntimeConfig
  readonly inputConfig?: InputConfig
  readonly publisher?: EnginePublisher
  readonly logger?: Logger
  /**
   * Schedule the periodic wake-up on `start()`. `false` leaves the loop entirely
   * in the caller's hands, which is what the tests and T11's virtual clock need:
   * a timer that fires inside a fake clock's `advance()` would interleave with
   * the assertions it is being measured by.
   */
  readonly autoTick?: boolean
}

export interface EngineHealth {
  readonly ready: boolean
  readonly degraded: boolean
  readonly degradedReasons: readonly string[]
  readonly interactionEnabled: boolean
  readonly stateRevision: number
  readonly processedIngestSeq: number
  readonly lastCommittedAt: string | null
  readonly openEffectCount: number
  readonly rendererCount: number
  readonly lastAckedStateRevision: number
  readonly inputMode: InputMode
  readonly broadcastLifecycle: BroadcastLifecycle
}

interface PreparedStep {
  readonly input: StepInput
  readonly now: string
  /** Set when a persisted deadline row is being delivered. */
  readonly deadline?: { readonly kind: string; readonly rowId: string }
  /** The event that produced this step, for the paid ledger and metrics. */
  readonly event?: CanonicalEvent
  /** Timers this step consumed, for the `deadlines` table. */
  readonly fired?: readonly ScheduledDeadline[]
}

interface HeldCommand {
  readonly ingestSeq: number
  readonly windowSequence: number
  readonly commandName: CommandName
  readonly event: CanonicalEvent
}

interface OpenEffect {
  readonly effect: Effect
  lastSentAt: string
}

export class StateEngine {
  readonly #store: PersistenceStore
  readonly #clock: Clock
  readonly #config: EngineRuntimeConfig
  readonly #inputConfig: InputConfig
  readonly #publisher: EnginePublisher
  readonly #logger: Logger
  readonly #metrics: EngineMetrics

  #world: WorldState
  #revision = 0
  #processedSeq = 0
  #inputMode: InputMode = 'direct'
  #arbiter: InputArbiter
  #ready = false
  #started = false
  #lastCommittedAt: string | null = null

  #inboxBuffer: InboxRow[] = []
  #drainedThroughSeq = 0
  #inboxExhausted = false
  /** Resolved rows waiting for a commit, ascending by `ingestSeq`. */
  #resolved: InboxProcessingRecord[] = []
  /** Aggregated commands whose window has not closed yet (spec §6.4). */
  #held: HeldCommand[] = []

  #openEffects = new Map<string, OpenEffect>()
  #lastAckedRevision = 0
  #lastPublishAt: string | null = null
  #inputHealth: InputHealth = 'ok'
  #interactionEnabled = false
  #timer: TimerHandle | null = null
  readonly #autoTick: boolean

  constructor(options: StateEngineOptions) {
    this.#store = options.store
    this.#clock = options.clock
    this.#config = options.config ?? loadEngineConfig()
    this.#inputConfig = options.inputConfig ?? loadInputConfig()
    this.#publisher = options.publisher ?? nullPublisher
    this.#logger = options.logger ?? silentLogger
    this.#autoTick = options.autoTick !== false
    this.#metrics = new EngineMetrics(this.#config.engine.metricsSampleSize)
    this.#world = initialWorldState({
      seed: this.#config.engine.worldSeed,
      startedAt: this.#clock.nowUtcIso(),
      identityGateOpen: this.#config.engine.identityGateOpen,
      creatureId: this.#config.engine.creatureId,
      tuning: this.#config.tuning,
    })
    this.#arbiter = new InputArbiter({
      clock: this.#clock,
      config: this.#inputConfig.window,
    })
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * The start-up order of spec §7.3(3): load the snapshot, apply the deadline
   * policies, drain the inbox — and only then signal `ready`, which is what T9
   * waits for before it resumes source reception.
   */
  start(): void {
    if (this.#started) return
    this.#started = true
    const now = this.#clock.nowUtcIso()
    const recovery = this.#store.loadRecoveryState(now)
    this.#revision = recovery.stateRevision
    this.#processedSeq = recovery.processedIngestSeq
    this.#drainedThroughSeq = recovery.processedIngestSeq

    if (recovery.engineState === null) {
      // Cold start (or a database written before this engine existed): the world
      // begins now and its first chapter beat is already due.
      this.#world = initialWorldState({
        seed: this.#config.engine.worldSeed,
        startedAt: now,
        identityGateOpen: this.#config.engine.identityGateOpen,
        creatureId: this.#config.engine.creatureId,
        tuning: this.#config.tuning,
      })
      this.#inputMode = 'direct'
      this.#logger.info('engine.cold_start', { revision: this.#revision })
    } else {
      const restored = parseEngineState(recovery.engineState)
      this.#world = restored.world
      this.#inputMode = restored.inputMode
    }
    this.#arbiter = new InputArbiter({
      clock: this.#clock,
      config: this.#inputConfig.window,
      initialMode: this.#inputMode,
    })

    // Effects committed but never acked are republished; the renderer ignores an
    // `effectId` it already played (spec §7.3(7)), so a republish is safe and a
    // missing one would drop a paid acknowledgement (spec §9.2).
    for (const open of recovery.unackedEffects) this.#adoptRecoveredEffect(open, now)

    this.#recoverDeadlines(now)
    this.#interactionEnabled = this.#computeInteractionEnabled(now)
    this.#runPending()
    this.#ready = true
    this.#publishSnapshotOnly()
    this.#scheduleTick()
  }

  stop(): void {
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#started = false
    this.#ready = false
  }

  get ready(): boolean {
    return this.#ready
  }

  /** Called after `commitIngestBatch` so the loop stops waiting for the tick. */
  notifyIngest(): void {
    this.#inboxExhausted = false
  }

  /**
   * Processes everything that is due now and returns the number of commits.
   * The timer calls it; tests call it directly so nothing depends on real time.
   */
  runPending(): number {
    return this.#runPending()
  }

  // ----------------------------------------------------------- renderer I/O

  /** A renderer attached: it needs the current state and every open effect. */
  onRendererHello(lastAppliedStateRevision: number | null): void {
    this.#publishSnapshotOnly()
    const now = this.#clock.nowUtcIso()
    for (const open of this.#openEffects.values()) {
      open.lastSentAt = now
      this.#publisher.publishEffect(open.effect)
      this.#metrics.count('effect_republished')
    }
    this.#logger.info('engine.renderer_hello', {
      lastAppliedStateRevision,
      revision: this.#revision,
    })
  }

  onAckState(stateRevision: number, appliedAt: string): void {
    if (stateRevision > this.#lastAckedRevision) this.#lastAckedRevision = stateRevision
    this.#metrics.recordStateAck(stateRevision, appliedAt)
    this.#metrics.count('ack_state')
  }

  onAckEffect(effectId: string, appliedAt: string): void {
    this.#openEffects.delete(effectId)
    this.#metrics.recordEffectAck(effectId, appliedAt)
    try {
      this.#store.markEffectAcked(effectId, appliedAt)
      this.#metrics.count('ack_effect')
    } catch (error) {
      // An ACK for an effect this server never published is the renderer's view
      // of another run; it is counted, not trusted, and never fabricated here.
      if (error instanceof UnknownEffectError || error instanceof EffectNotPublishedError) {
        this.#metrics.count('ack_effect_unknown')
        return
      }
      throw error
    }
  }

  /** Health of the input path, reported by the source adapter (spec §9.4(3)). */
  reportInputHealth(health: InputHealth): void {
    this.#inputHealth = health
  }

  // -------------------------------------------------------------- read side

  snapshot(): WorldSnapshot {
    return this.#buildSnapshot(this.#revision, this.#processedSeq)
  }

  health(): EngineHealth {
    const now = this.#clock.nowUtcIso()
    const reasons = this.#degradedReasons(now)
    return {
      ready: this.#ready,
      degraded: reasons.length > 0,
      degradedReasons: reasons,
      interactionEnabled: this.#interactionEnabled,
      stateRevision: this.#revision,
      processedIngestSeq: this.#processedSeq,
      lastCommittedAt: this.#lastCommittedAt,
      openEffectCount: this.#openEffects.size,
      rendererCount: this.#publisher.rendererCount,
      lastAckedStateRevision: this.#lastAckedRevision,
      inputMode: this.#arbiter.mode,
      broadcastLifecycle: this.#lifecycle(now),
    }
  }

  metrics(): EngineMetricsSnapshot {
    return this.#metrics.snapshot()
  }

  // ----------------------------------------------------------------- loop

  #runPending(): number {
    let commits = 0
    // Every pass re-asks the inbox: a batch committed by another path (the
    // simulator endpoint, T9's adapter) between two ticks must not wait for a
    // `notifyIngest` that a future caller might forget.
    this.#inboxExhausted = false
    // Reconciled before the loop as well as after it: an event must never be
    // applied while the published snapshot still says interaction is suspended.
    commits += this.#reconcileInteraction(this.#clock.nowUtcIso())
    for (let iteration = 0; ; iteration += 1) {
      if (iteration >= MAX_STEPS_PER_PASS) {
        // A timer that never leaves the due set would spin here. Stopping and
        // saying so is the only honest option: the alternative is a hot loop
        // that looks like a working engine (spec §9.4(2)).
        this.#logger.error('engine.pass_limit_reached', { revision: this.#revision })
        this.#metrics.count('pass_limit_reached')
        break
      }
      const now = this.#clock.nowUtcIso()
      commits += this.#flushClosedWindows(now)
      const outcome = this.#advanceOnce(now)
      if (outcome === 'idle') break
      if (outcome === 'committed') commits += 1
    }
    const now = this.#clock.nowUtcIso()
    commits += this.#flushResolved(now)
    commits += this.#reconcileInteraction(now)
    this.#sweepEffects(now)
    return commits
  }

  /**
   * One merged input. `consumed` means the input was resolved without a state
   * change — an unsupported envelope, an expired command, a held aggregate —
   * which is progress, so the caller keeps going; only `idle` ends the pass.
   */
  #advanceOnce(now: string): 'idle' | 'consumed' | 'committed' {
    const deadline = this.#nextDueDeadline(now)
    const row = this.#holdingEvents() ? null : this.#peekRow()
    if (row === null && deadline === null) return 'idle'

    // An event that arrived at or before a timer's due time wins the tie: the
    // room saw the input first, so the world applies it before the clock moves
    // on — the same rule `runWorld` (T7) uses, which keeps the two comparable.
    if (deadline !== null && (row === null || toMillis(deadline.dueAt) < toMillis(row.receivedAt))) {
      return this.#applySteps([this.#prepareDeadline(deadline)], now) ? 'committed' : 'consumed'
    }
    const prepared = this.#prepareEvent(row as InboxRow, now)
    if (prepared === null) return 'consumed'
    return this.#applySteps([prepared], now) ? 'committed' : 'consumed'
  }

  #scheduleTick(): void {
    if (!this.#started || !this.#autoTick) return
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null
      try {
        this.#runPending()
      } catch (error) {
        this.#logger.error('engine.tick_failed', { error: (error as Error).message })
      }
      this.#scheduleTick()
    }, this.#config.engine.tickIntervalMs)
  }

  #nextDueDeadline(now: string): ScheduledDeadline | null {
    let earliest: ScheduledDeadline | null = null
    const nowMs = toMillis(now)
    for (const deadline of pendingDeadlines(this.#world)) {
      if (toMillis(deadline.dueAt) > nowMs) continue
      if (earliest === null || toMillis(deadline.dueAt) < toMillis(earliest.dueAt)) {
        earliest = deadline
      }
    }
    return earliest
  }

  #prepareDeadline(deadline: ScheduledDeadline): PreparedStep {
    return {
      input: { kind: 'deadline', deadline },
      now: this.#advanceTo(deadline.dueAt),
      deadline: { kind: deadline.kind, rowId: deadlineRowIdOf(deadline) },
      fired: [deadline],
    }
  }

  /** World time never moves backwards, whatever a source or a timer claims. */
  #advanceTo(instant: string): string {
    return toMillis(instant) < toMillis(this.#world.world.worldTimeUtc)
      ? this.#world.world.worldTimeUtc
      : instant
  }

  #peekRow(): InboxRow | null {
    if (this.#inboxBuffer.length > 0) return this.#inboxBuffer[0] as InboxRow
    if (this.#inboxExhausted) return null
    const rows = this.#store.drainUnprocessed(
      this.#drainedThroughSeq,
      this.#config.engine.drainBatchSize,
    )
    if (rows.length < this.#config.engine.drainBatchSize) this.#inboxExhausted = true
    if (rows.length === 0) return null
    this.#inboxBuffer = rows
    this.#drainedThroughSeq = (rows[rows.length - 1] as InboxRow).ingestSeq
    return rows[0] as InboxRow
  }

  #takeRow(): InboxRow {
    const row = this.#inboxBuffer.shift()
    if (row === undefined) throw new Error('engine: takeRow with an empty buffer')
    return row
  }

  /**
   * Spec §9.2: while the world is degraded, events stay in the inbox. They are
   * not dropped and they are not shown as accepted — timers keep running, so the
   * room keeps moving, and the backlog is drained when the condition clears.
   */
  #holdingEvents(): boolean {
    return this.#degradedReasons(this.#clock.nowUtcIso()).length > 0
  }

  // -------------------------------------------------------------- one event

  #prepareEvent(row: InboxRow, now: string): PreparedStep | null {
    this.#takeRow()

    if (row.envelope.validationStatus !== 'valid') {
      // Spec §7.3(3): an invalid or unsupported envelope advances with a reason.
      this.#resolve(row.ingestSeq, `${row.envelope.validationStatus}:${row.envelope.validationError.code}`)
      this.#metrics.count(`envelope_${row.envelope.validationStatus}`)
      return null
    }

    const event = toCanonicalEvent(row.envelope, row.ingestSeq)
    const paidKind = paidEventKindOf(event)

    if (paidKind === null && this.#isExpired(event, now)) {
      // The pre-approved validity of spec §9.2 has passed; the command is
      // recorded as expired rather than applied late or silently dropped.
      this.#resolve(row.ingestSeq, 'expired')
      this.#metrics.count('event_expired')
      return null
    }

    if (paidKind !== null) return this.#preparePaidEvent(row, event, paidKind)

    const command = event.command
    if (event.kind !== 'CHAT_COMMAND' || command === null) {
      this.#resolve(row.ingestSeq, 'not_a_world_input')
      this.#metrics.count('event_not_a_world_input')
      return null
    }

    const admission = this.#arbiter.admit(command)
    if (admission.disposition === 'aggregated') {
      // Held, not resolved: the recovery cursor stays below this row until the
      // window closes, so a crash re-drains it (spec §6.4 "기여 수 보존").
      this.#held.push({
        ingestSeq: row.ingestSeq,
        windowSequence: admission.windowSequence,
        commandName: command.name,
        event,
      })
      this.#metrics.count('command_aggregated')
      return null
    }

    this.#resolve(row.ingestSeq, 'applied')
    this.#metrics.count('command_direct')
    return { input: { kind: 'event', event: this.#sanitizeArgument(event), contributions: 1 }, now: this.#advanceTo(event.receivedAt), event }
  }

  #preparePaidEvent(row: InboxRow, event: CanonicalEvent, paidKind: PaidEventKind): PreparedStep | null {
    // Idempotency unit 1: the ledger's primary key, which survives a restart and
    // any ring eviction in the world's audit state (spec §11 유료 무결성).
    if (this.#store.hasPaidLedgerEntry(event.eventKey)) {
      this.#resolve(row.ingestSeq, 'duplicate_paid')
      this.#metrics.count('paid_duplicate')
      return null
    }
    // Idempotency unit 2: the non-decreasing gift maximum. A combo step that
    // adds nothing stages nothing (spec §7.4).
    if (paidKind === 'GIFT') {
      const baseKey = giftBaseKey(event.eventKey)
      const effectiveCount = effectiveGiftCount(event.payment?.comboCount ?? null)
      if (effectiveCount - this.#store.getGiftStoredMax(baseKey) <= 0) {
        this.#resolve(row.ingestSeq, 'gift_no_delta')
        this.#metrics.count('gift_no_delta')
        return null
      }
    }
    this.#resolve(row.ingestSeq, 'applied')
    this.#metrics.count('paid_applied')
    return { input: { kind: 'event', event }, now: this.#advanceTo(event.receivedAt), event }
  }

  #isExpired(event: CanonicalEvent, now: string): boolean {
    return toMillis(now) - toMillis(event.receivedAt) > this.#config.engine.degraded.eventValidityMs
  }

  /**
   * TASK_SPECS §T8: an argument only reaches the world when the open choice
   * window expects that vocabulary. Anything else is dropped with a reason code
   * and never stored — the rejected token itself is not logged (spec §12.3).
   */
  #sanitizeArgument(event: CanonicalEvent): CanonicalEvent {
    const command = event.command
    if (command === null || command.argument === null) return event
    const expected = this.#world.world.choice?.options.map((option) => option.choiceId) ?? []
    if (expected.includes(command.argument)) return event
    this.#metrics.count('command_argument_rejected')
    return { ...event, command: { name: command.name, argument: null } }
  }

  // ------------------------------------------------------- aggregate windows

  /**
   * Closes any tally window that came due and applies what is still owed.
   *
   * Only `aggregatedOnly` is applied: `directApplied` was acted on as it arrived
   * (TASK_SPECS §T8, R-T6-1). The contributions travel on the last real event of
   * that command in the window — no synthetic event is invented for the tally
   * (spec §2.6).
   */
  #flushClosedWindows(now: string): number {
    const closed = this.#arbiter.drainClosedWindows()
    if (closed.length === 0) return 0

    let commits = 0
    for (const window of closed) {
      const held = this.#held.filter((entry) => entry.windowSequence === window.sequence)
      this.#held = this.#held.filter((entry) => entry.windowSequence !== window.sequence)
      if (held.length === 0) continue

      const steps: PreparedStep[] = []
      for (const [name, tally] of Object.entries(window.counts) as [
        CommandName,
        { directApplied: number; aggregatedOnly: number },
      ][]) {
        if (tally.aggregatedOnly <= 0) continue
        const representative = held.filter((entry) => entry.commandName === name).at(-1)
        if (representative === undefined) continue
        steps.push({
          input: {
            kind: 'event',
            event: this.#sanitizeArgument(representative.event),
            contributions: tally.aggregatedOnly,
          },
          now: this.#advanceTo(maxInstant(window.endedAtUtc, now)),
          event: representative.event,
        })
      }
      for (const entry of held) this.#resolve(entry.ingestSeq, 'aggregated')
      this.#metrics.count('aggregate_window_closed')
      if (this.#applySteps(steps, now)) commits += 1
    }
    return commits
  }

  // ---------------------------------------------------------------- commits

  /**
   * Runs the reducer for each prepared input and confirms all of it in one
   * transaction (spec §7.3(5)). Returns false when there was nothing to write.
   */
  #applySteps(steps: readonly PreparedStep[], now: string, force = false): boolean {
    const plan = this.#cursorPlan()
    if (steps.length === 0 && plan.records.length === 0 && !force) return false

    const revision = this.#revision + 1
    const previousPending = pendingDeadlines(this.#world)
    let state = this.#world
    const transitions: WorldTransition[] = []
    const drafts: { draft: EffectDraft; deadline?: { kind: string; rowId: string } }[] = []
    const fired: ScheduledDeadline[] = []
    const eventsByKey = new Map<string, CanonicalEvent>()

    for (const prepared of steps) {
      const result = step(state, prepared.input, prepared.now, stepRngFor(state, prepared.input), {
        tuning: this.#config.tuning,
      })
      state = result.state
      transitions.push(...result.transitions)
      for (const draft of result.effects) {
        drafts.push(prepared.deadline === undefined ? { draft } : { draft, deadline: prepared.deadline })
      }
      fired.push(...(prepared.fired ?? []))
      if (prepared.event !== undefined) eventsByKey.set(prepared.event.eventKey, prepared.event)
      for (const rejection of result.rejections) this.#metrics.count(`rejected_${rejection.reason}`)
    }

    const effects = drafts.map((entry, index) =>
      assembleEffect(
        entry.draft,
        { revision, ...(entry.deadline === undefined ? {} : { deadline: entry.deadline }) },
        index,
      ),
    )
    const paidLedger = this.#paidLedgerFor(effects, eventsByKey, now)
    const giftCombo = this.#giftComboFor(effects, eventsByKey)
    const nextPending = pendingDeadlines(state)
    const deadlines = deadlineTableDiff({ previous: previousPending, next: nextPending, fired })

    this.#inputMode = this.#arbiter.mode
    const snapshot = this.#buildSnapshot(revision, plan.processedSeq, state)

    this.#store.commitStateTransition({
      snapshot,
      revision,
      processedSeq: plan.processedSeq,
      transitions: [
        {
          revision,
          causedByEventKey: steps.find((it) => it.event !== undefined)?.event?.eventKey ?? null,
          kind: summarizeTransitions(transitions),
          at: state.world.worldTimeUtc,
        },
      ],
      processed: plan.records,
      deadlines,
      effects,
      paidLedger,
      giftCombo,
      engineState: serializeEngineState(state, this.#inputMode),
    })

    this.#world = state
    this.#revision = revision
    this.#processedSeq = plan.processedSeq
    this.#resolved = this.#resolved.slice(plan.records.length)
    const committedAt = this.#clock.nowUtcIso()
    this.#lastCommittedAt = committedAt
    const receivedAt = steps.find((it) => it.event !== undefined)?.event?.receivedAt ?? null
    this.#metrics.recordCommit(revision, receivedAt, committedAt)
    this.#metrics.count('commit')

    this.#publish(snapshot, effects, committedAt)
    return true
  }

  /**
   * How far the recovery cursor may move, and with which records.
   *
   * Never past a held row: `commitStateTransition` rejects a cursor that would
   * pass an inbox row with no processing record, and that rejection is the
   * point — a row left below the cursor would never be drained again (§7.3(3)).
   */
  #cursorPlan(): { records: InboxProcessingRecord[]; processedSeq: number } {
    const firstHeld = this.#held.reduce(
      (min, entry) => Math.min(min, entry.ingestSeq),
      Number.POSITIVE_INFINITY,
    )
    const records: InboxProcessingRecord[] = []
    for (const record of this.#resolved) {
      if (record.ingestSeq >= firstHeld) break
      records.push(record)
    }
    const last = records.at(-1)
    return { records, processedSeq: last?.ingestSeq ?? this.#processedSeq }
  }

  #resolve(ingestSeq: number, result: string): void {
    this.#resolved.push({ ingestSeq, result, at: this.#clock.nowUtcIso() })
  }

  /** Commits resolved rows that produced no state change, so the cursor moves. */
  #flushResolved(now: string): number {
    return this.#applySteps([], now) ? 1 : 0
  }

  #paidLedgerFor(
    effects: readonly Effect[],
    eventsByKey: ReadonlyMap<string, CanonicalEvent>,
    now: string,
  ): PaidLedgerRecord[] {
    const records: PaidLedgerRecord[] = []
    for (const effect of effects) {
      if (!effect.paid || effect.causedByEventKey === null) continue
      const event = eventsByKey.get(effect.causedByEventKey)
      if (event === undefined) continue
      const kind = paidEventKindOf(event)
      if (kind === null) continue
      records.push({
        eventKey: event.eventKey,
        kind,
        amountMicros: event.payment?.amountMicros ?? null,
        currency: event.payment?.currency ?? null,
        tier: event.payment?.tier ?? null,
        jewels: event.payment?.jewels ?? null,
        appliedAt: now,
      })
    }
    return records
  }

  #giftComboFor(
    effects: readonly Effect[],
    eventsByKey: ReadonlyMap<string, CanonicalEvent>,
  ): { baseKey: string; effectiveCount: number }[] {
    const requests: { baseKey: string; effectiveCount: number }[] = []
    for (const effect of effects) {
      if (!effect.paid || effect.causedByEventKey === null) continue
      const event = eventsByKey.get(effect.causedByEventKey)
      if (event === undefined || event.kind !== 'GIFT') continue
      requests.push({
        baseKey: giftBaseKey(event.eventKey),
        effectiveCount: effectiveGiftCount(event.payment?.comboCount ?? null),
      })
    }
    return requests
  }

  // -------------------------------------------------------------- publishing

  #publish(snapshot: WorldSnapshot, effects: readonly Effect[], committedAt: string): void {
    const publishedAt = this.#clock.nowUtcIso()
    this.#publisher.publishSnapshot(snapshot)
    this.#metrics.recordSnapshotPublish(snapshot.stateRevision, publishedAt)
    this.#lastPublishAt = publishedAt
    for (const effect of effects) {
      this.#store.markEffectPublished(effect.effectId, publishedAt)
      this.#openEffects.set(effect.effectId, { effect, lastSentAt: publishedAt })
      this.#publisher.publishEffect(effect)
      this.#metrics.recordPublish(effect.effectId, committedAt, publishedAt)
      this.#metrics.count('effect_published')
    }
  }

  #publishSnapshotOnly(): void {
    const snapshot = this.#buildSnapshot(this.#revision, this.#processedSeq)
    this.#publisher.publishSnapshot(snapshot)
    this.#lastPublishAt = this.#clock.nowUtcIso()
  }

  /** Puts a recovered outbox row back on the wire (spec §7.3(7), §11 상태 복구). */
  #adoptRecoveredEffect(open: PersistedEffect, now: string): void {
    this.#openEffects.set(open.effect.effectId, { effect: open.effect, lastSentAt: now })
    if (open.publishedAt === null) this.#store.markEffectPublished(open.effect.effectId, now)
    this.#publisher.publishEffect(open.effect)
    this.#metrics.count('effect_republished')
  }

  /**
   * Retransmit and expiry of spec §7.3(7). A renderer that missed an effect gets
   * it again; one whose window has passed without an ACK is recorded `expired`
   * so the substitute acknowledgement of spec §9.2 can be the world's decision
   * and not a guess made on the wire.
   */
  #sweepEffects(now: string): void {
    const nowMs = toMillis(now)
    for (const [effectId, open] of [...this.#openEffects.entries()]) {
      if (nowMs > toMillis(open.effect.endsAt) + this.#config.engine.effects.expiryGraceMs) {
        this.#openEffects.delete(effectId)
        this.#store.markEffectExpired(effectId, now)
        this.#metrics.count('effect_expired')
        continue
      }
      if (this.#publisher.rendererCount === 0) continue
      if (nowMs - toMillis(open.lastSentAt) < this.#config.engine.effects.retransmitIntervalMs) {
        continue
      }
      open.lastSentAt = now
      this.#publisher.publishEffect(open.effect)
      this.#metrics.count('effect_retransmitted')
    }
  }

  // ---------------------------------------------------------------- degraded

  /**
   * Spec §9.2: the CTA is disabled while the input path or the renderer ACK is
   * unhealthy. Each reason is a stable token so `/health` can report *why*
   * without the aggregator (T12) having to re-derive it.
   */
  #degradedReasons(now: string): string[] {
    const reasons: string[] = []
    if (this.#inputHealth !== 'ok') reasons.push(`input_${this.#inputHealth}`)
    if (this.#publisher.rendererCount === 0) reasons.push('no_renderer')
    else if (
      this.#lastAckedRevision < this.#revision &&
      this.#lastPublishAt !== null &&
      toMillis(now) - toMillis(this.#lastPublishAt) >
        this.#config.engine.degraded.rendererAckTimeoutMs
    ) {
      reasons.push('renderer_ack_stale')
    }
    return reasons
  }

  #computeInteractionEnabled(now: string): boolean {
    return this.#degradedReasons(now).length === 0
  }

  /**
   * Publishes the CTA switch when it flips. It is a real change to the read
   * model, so it gets its own revision rather than being sent out of band —
   * a renderer that reconnects must see the same value the store holds.
   */
  #reconcileInteraction(now: string): number {
    const enabled = this.#computeInteractionEnabled(now)
    if (enabled === this.#interactionEnabled) return 0
    this.#interactionEnabled = enabled
    this.#metrics.count(enabled ? 'interaction_enabled' : 'interaction_disabled')
    if (!this.#ready) return 0
    return this.#applySteps([], now, true) ? 1 : 0
  }

  #lifecycle(now: string): BroadcastLifecycle {
    if (!this.#ready) return 'starting'
    return this.#degradedReasons(now).length > 0 ? 'degraded' : 'live'
  }

  #buildSnapshot(revision: number, processedSeq: number, state: WorldState = this.#world): WorldSnapshot {
    const now = this.#clock.nowUtcIso()
    const window = this.#arbiter.currentWindow()
    const showWindow = window.mode === 'aggregate' || window.tallies.length > 0
    return buildSnapshot(state, {
      revision,
      processedIngestSeq: processedSeq,
      inputMode: window.mode,
      interactionEnabled: this.#interactionEnabled,
      broadcastLifecycle: this.#lifecycle(now),
      ...(showWindow ? { aggregateWindow: window } : {}),
    })
  }

  // ---------------------------------------------------------------- recovery

  /**
   * The §10.2 downtime policies, applied by the world itself (T7
   * `recoverDeadlines`): the engine delivers what the plan says to deliver,
   * records what it says to expire, and never decides the domain question of
   * which timer still matters.
   */
  #recoverDeadlines(now: string): void {
    const before = pendingDeadlines(this.#world)
    const recovery = recoverDeadlines(this.#world, now, { tuning: this.#config.tuning })
    this.#world = recovery.state
    const plan = recovery.plan
    if (plan.expired.length === 0 && plan.rescheduled.length === 0 && plan.deliver.length === 0) {
      return
    }

    if (plan.expired.length > 0 || plan.rescheduled.length > 0) {
      const revision = this.#revision + 1
      const snapshot = this.#buildSnapshot(revision, this.#processedSeq)
      this.#store.commitStateTransition({
        snapshot,
        revision,
        processedSeq: this.#processedSeq,
        transitions: [
          { revision, causedByEventKey: null, kind: 'deadline_recovery', at: now },
        ],
        deadlines: deadlineTableDiff({
          previous: before,
          next: pendingDeadlines(this.#world),
          expired: plan.expired,
        }),
        engineState: serializeEngineState(this.#world, this.#inputMode),
      })
      this.#revision = revision
      this.#lastCommittedAt = this.#clock.nowUtcIso()
      this.#metrics.count('deadline_recovery_commit')
      this.#metrics.count('deadline_expired', plan.expired.length)
    }

    // Delivered at the recovery instant, not at the moment they were missed: the
    // policy has already decided *whether* the occurrence still happens, and the
    // handlers integrate from absolute state (see T7 `deadlines.ts` rationale).
    for (const deadline of plan.deliver) {
      this.#applySteps(
        [
          {
            input: { kind: 'deadline', deadline },
            now: this.#advanceTo(now),
            deadline: { kind: deadline.kind, rowId: deadlineRowIdOf(deadline) },
            fired: [deadline],
          },
        ],
        now,
      )
    }
  }
}

/** The §7.4 canonical event for a validated envelope, plus its issued sequence. */
export function toCanonicalEvent(envelope: ValidIngestEnvelope, ingestSeq: number): CanonicalEvent {
  return CanonicalEventSchema.parse({
    schemaVersion: envelope.schemaVersion,
    eventKey: eventKeyForEnvelope(envelope),
    ingestSeq,
    source: envelope.source,
    broadcastId: envelope.broadcastId,
    liveChatId: envelope.liveChatId,
    kind: envelope.kind,
    occurredAt: envelope.occurredAt,
    receivedAt: envelope.receivedAt,
    actor: null,
    command: envelope.command,
    payment: envelope.payment,
    sourceDataExpiresAt: sourceDataExpiresAt(envelope.receivedAt),
  })
}

/** `youtube:{broadcastId}:{messageId}` for a gift key (spec §7.4). */
export function giftBaseKey(eventKey: string): string {
  const marker = eventKey.lastIndexOf(':gift:')
  return marker === -1 ? eventKey : eventKey.slice(0, marker)
}

/**
 * One `state_transitions` row per revision (the table's primary key), holding
 * every transition type the step produced. Types are a closed vocabulary, so the
 * summary can never carry a message or a name.
 */
function summarizeTransitions(transitions: readonly WorldTransition[]): string {
  if (transitions.length === 0) return 'no_transition'
  const types = transitions.map((transition) => transition.type)
  return types.length <= 8 ? types.join('+') : `${types.slice(0, 8).join('+')}+more`
}

function maxInstant(a: string, b: string): string {
  return toMillis(a) >= toMillis(b) ? a : b
}
