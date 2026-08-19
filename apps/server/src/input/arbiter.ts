import {
  CommandNameSchema,
  type AggregateWindow,
  type CommandName,
  type CommandRef,
  type ConsentedActor,
  type InputMode,
} from '@vl/contract'

import type { Clock } from '../clock.js'

/**
 * Input arbiter of spec §6.4 and §7.3(4)(8).
 *
 * Two modes over a fixed tumbling window:
 *
 * - `direct` — accepted commands are applied in arrival order, up to
 *   `maxDirectPerWindow` per window. That cap is the **global** flood control
 *   spec §6.4 allows while the identity gate is closed; the excess is not
 *   dropped, it stops being applied individually and is counted into the
 *   window's tally instead ("집계로만 반영", contributions preserved).
 * - `aggregate` — nothing is applied individually; every command counts toward
 *   the window tally, and the world reads the tally when the window closes.
 *
 * Per-user fairness applies to **consented viewers only** (BOARD D-9, A-9).
 * A viewer who sent `JOIN` has a `channelRef`, so two rules the anonymous path
 * cannot make become possible for them:
 *
 * - a cooldown: their next command is not applied individually until
 *   `perUser.cooldownMs` has passed;
 * - one vote: a second `VOTE_A/B/C` inside the same open choice window is not
 *   counted twice.
 *
 * Both are `suppressed` rather than aggregated — the point of a cooldown is that
 * the command does not contribute, so folding it into the tally would defeat it.
 * For everyone else nothing changes: `actor` is `null`, no per-user claim is
 * made, and the global flood control of the window is the only limit (spec §6.4,
 * §7.3(4), BOARD A-1). The state is keyed by `channelRef` and never by a channel
 * id — the arbiter has no way to learn one.
 *
 * All time comes from the injected `Clock`: intervals from `monotonicMs()`,
 * reported instants from `nowUtcIso()` captured once at construction (spec
 * §10.2). Mode changes are therefore reproducible in tests to the millisecond.
 */

export interface InputWindowConfig {
  /** Tally window length. Provisional until event rates are measured (A-3). */
  readonly windowMs: number
  /** Commands in one window that push the *next* window into `aggregate`. */
  readonly enterAggregateAtCommands: number
  /** Commands in one window at or below which the next window returns to `direct`. */
  readonly exitAggregateAtCommands: number
  /** Global flood-control cap on individually applied commands per window. */
  readonly maxDirectPerWindow: number
}

/**
 * Per-consented-viewer rules (BOARD D-9, A-9). Inert while the consent gate is
 * closed, because no message then carries an actor.
 */
export interface InputPerUserConfig {
  /**
   * Minimum gap between two individually applied commands from one consented
   * viewer. Provisional (BOARD A-3/A-15): spec §6.4 fixes no number, and this
   * one is the tally window length, so a consented viewer contributes at most
   * once per window — the same pacing the on-screen tally already shows.
   */
  readonly cooldownMs: number
}

/** Why a consented viewer's command was not counted at all. */
export type SuppressionReason =
  /** Their previous command is still inside `perUser.cooldownMs`. */
  | 'cooldown'
  /** They already voted in this choice window (spec §6.4 한 표, BOARD A-9). */
  | 'already_voted'

/** What the arbiter decided for one accepted command. */
export interface ArbiterAdmission {
  /**
   * `direct` = apply in order; `aggregated` = counted in the window tally only;
   * `suppressed` = not applied and **not** tallied (consented viewers only).
   */
  readonly disposition: 'direct' | 'aggregated' | 'suppressed'
  /** Mode of the window the command landed in. */
  readonly mode: InputMode
  readonly command: CommandRef
  readonly windowSequence: number
  /** Present exactly when `disposition` is `suppressed`. */
  readonly reason?: SuppressionReason
}

/**
 * One command's share of a window, split by what the consumer still owes.
 *
 * The split is the whole point of the payload. `directApplied` was already
 * returned to the caller with `disposition: 'direct'` and acted on as it
 * arrived; `aggregatedOnly` never was. A single total cannot express that: a
 * caller applying it would replay the direct commands, and a caller skipping it
 * would lose the aggregated ones (R-T6-1 blocker 2). Adding the two back
 * together gives the contribution count spec §6.4 requires be preserved, which
 * is what the on-screen tally shows.
 */
export interface CommandWindowTally {
  readonly directApplied: number
  readonly aggregatedOnly: number
}

/** A closed window. Every accepted command in it is represented in `counts`. */
export interface AggregateWindowResult {
  readonly sequence: number
  readonly mode: InputMode
  readonly startedAtUtc: string
  readonly endedAtUtc: string
  /**
   * Per-command split. Apply `aggregatedOnly`; `directApplied` is already done.
   * Every tally summed over both fields equals `acceptedCount`.
   */
  readonly counts: Readonly<Record<CommandName, CommandWindowTally>>
  readonly acceptedCount: number
  /** Sum of every `counts[*].directApplied`. */
  readonly directAppliedCount: number
  /** Sum of every `counts[*].aggregatedOnly`. */
  readonly aggregatedCount: number
  /** Mode the next window runs in, derived from `acceptedCount`. */
  readonly nextMode: InputMode
}

export interface InputArbiterOptions {
  readonly clock: Clock
  readonly config: InputWindowConfig
  /** Per-consented-viewer rules; omitted means the rules are off. */
  readonly perUser?: InputPerUserConfig
  /**
   * Starting mode; `direct` per BOARD A-3. T8 passes the recovered
   * `WorldSnapshot.inputMode` here so a restart does not silently drop a
   * running aggregate window back to direct (spec §10.2).
   */
  readonly initialMode?: InputMode
}

export class InputArbiterConfigError extends Error {
  constructor(message: string) {
    super(`invalid input arbiter config: ${message}`)
    this.name = 'InputArbiterConfigError'
  }
}

interface MutableTally {
  directApplied: number
  aggregatedOnly: number
}

function emptyCounts(): Record<CommandName, MutableTally> {
  const counts = {} as Record<CommandName, MutableTally>
  for (const name of CommandNameSchema.options) {
    counts[name] = { directApplied: 0, aggregatedOnly: 0 }
  }
  return counts
}

function freezeCounts(
  counts: Record<CommandName, MutableTally>,
): Record<CommandName, CommandWindowTally> {
  const copy = {} as Record<CommandName, CommandWindowTally>
  for (const name of CommandNameSchema.options) {
    copy[name] = { ...counts[name] }
  }
  return copy
}

/** What one consented viewer has done recently. Keyed by `channelRef` only. */
interface ViewerState {
  /** Monotonic reading of their last individually applied command. */
  lastAdmittedMs: number
  /** Choice window they have already voted in, or `null`. */
  votedScope: string | null
}

export class InputArbiter {
  readonly #clock: Clock
  readonly #config: InputWindowConfig
  readonly #perUser: InputPerUserConfig | undefined
  readonly #baseMonotonicMs: number
  readonly #baseEpochMs: number
  /**
   * Per-viewer state, dropped as soon as its cooldown has expired and its vote
   * scope is stale (`#pruneViewers`). It holds no name and no channel id — a
   * `channelRef` whose consent row was deleted is an unresolvable random string.
   */
  readonly #viewers = new Map<string, ViewerState>()

  #windowIndex = 0
  #mode: InputMode
  #counts = emptyCounts()
  #accepted = 0
  #directApplied = 0
  #aggregated = 0
  #closed: AggregateWindowResult[] = []

  constructor(options: InputArbiterOptions) {
    const { windowMs, enterAggregateAtCommands, exitAggregateAtCommands, maxDirectPerWindow } =
      options.config
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new InputArbiterConfigError('windowMs must be a positive integer')
    }
    if (exitAggregateAtCommands > enterAggregateAtCommands) {
      throw new InputArbiterConfigError(
        'exitAggregateAtCommands must not exceed enterAggregateAtCommands',
      )
    }
    if (maxDirectPerWindow < 0) {
      throw new InputArbiterConfigError('maxDirectPerWindow must not be negative')
    }
    if (options.perUser !== undefined && options.perUser.cooldownMs < 0) {
      throw new InputArbiterConfigError('perUser.cooldownMs must not be negative')
    }
    this.#clock = options.clock
    this.#config = options.config
    this.#perUser = options.perUser
    this.#mode = options.initialMode ?? 'direct'
    this.#baseMonotonicMs = options.clock.monotonicMs()
    this.#baseEpochMs = Date.parse(options.clock.nowUtcIso())
    if (Number.isNaN(this.#baseEpochMs)) {
      throw new InputArbiterConfigError('clock.nowUtcIso() is not a parseable instant')
    }
  }

  /** Mode of the window that is open right now. */
  get mode(): InputMode {
    this.#sync()
    return this.#mode
  }

  /**
   * Records one accepted command and says how the engine should treat it.
   * Closing any window that came due first is what makes the decision depend
   * only on the clock and not on call order.
   *
   * `actor` is the consented viewer who sent it, when there is one (BOARD D-9),
   * and `voteScope` identifies the open choice window so "one vote" means one
   * vote per decision rather than one vote ever. Both are optional and both
   * default to the anonymous behaviour this method had before D-9.
   */
  admit(
    command: CommandRef,
    actor: ConsentedActor | null = null,
    voteScope: string | null = null,
  ): ArbiterAdmission {
    this.#sync()

    const suppression = this.#suppressionFor(command, actor, voteScope)
    if (suppression !== null) {
      // Not counted in `#accepted` either: the mode threshold measures how much
      // input the room is producing, and a command that changes nothing is not
      // input the world has to protect itself from.
      return {
        disposition: 'suppressed',
        mode: this.#mode,
        command,
        windowSequence: this.#windowIndex,
        reason: suppression,
      }
    }

    this.#accepted += 1
    const applyDirectly =
      this.#mode === 'direct' && this.#directApplied < this.#config.maxDirectPerWindow
    if (applyDirectly) {
      this.#counts[command.name].directApplied += 1
      this.#directApplied += 1
    } else {
      this.#counts[command.name].aggregatedOnly += 1
      this.#aggregated += 1
    }
    if (actor !== null) this.#recordViewer(actor.channelRef, command, voteScope)
    return {
      disposition: applyDirectly ? 'direct' : 'aggregated',
      mode: this.#mode,
      command,
      windowSequence: this.#windowIndex,
    }
  }

  /**
   * The per-user rules, applied only to a consented viewer. Returns `null` when
   * the command may proceed, which is always the case for `actor === null`.
   */
  #suppressionFor(
    command: CommandRef,
    actor: ConsentedActor | null,
    voteScope: string | null,
  ): SuppressionReason | null {
    if (actor === null || this.#perUser === undefined) return null
    const viewer = this.#viewers.get(actor.channelRef)
    if (viewer === undefined) return null
    if (isVote(command.name) && voteScope !== null && viewer.votedScope === voteScope) {
      return 'already_voted'
    }
    const elapsed = this.#clock.monotonicMs() - viewer.lastAdmittedMs
    return elapsed < this.#perUser.cooldownMs ? 'cooldown' : null
  }

  #recordViewer(channelRef: string, command: CommandRef, voteScope: string | null): void {
    const votedScope = isVote(command.name) && voteScope !== null ? voteScope : null
    const existing = this.#viewers.get(channelRef)
    this.#viewers.set(channelRef, {
      lastAdmittedMs: this.#clock.monotonicMs(),
      votedScope: votedScope ?? existing?.votedScope ?? null,
    })
  }

  /**
   * Forgets viewers whose cooldown has expired and who have no vote to remember.
   * Called when a window closes, so the map tracks the recently active room
   * rather than growing for the length of the broadcast.
   */
  #pruneViewers(): void {
    if (this.#perUser === undefined) {
      this.#viewers.clear()
      return
    }
    const now = this.#clock.monotonicMs()
    for (const [channelRef, viewer] of this.#viewers) {
      if (viewer.votedScope === null && now - viewer.lastAdmittedMs >= this.#perUser.cooldownMs) {
        this.#viewers.delete(channelRef)
      }
    }
  }

  /**
   * Drops the remembered vote of a choice window that has closed.
   *
   * Called by the engine every time the open choice changes (review round 1,
   * M4): a viewer who voted is exempt from `#pruneViewers` while the vote is
   * remembered, so without this their `channelRef` would stay in memory for the
   * rest of the broadcast — long after the decision it belonged to.
   */
  forgetVoteScope(voteScope: string): void {
    for (const [channelRef, viewer] of this.#viewers) {
      if (viewer.votedScope === voteScope) {
        this.#viewers.set(channelRef, { ...viewer, votedScope: null })
      }
    }
    this.#pruneViewers()
  }

  /**
   * Drops one viewer's state outright, because the identity behind the reference
   * has been deleted — `LEAVE`, a user deletion request, or the 30-day sweep
   * (BOARD D-9, spec §12.4).
   *
   * The entry holds no name and no channel id, so what is removed is a random
   * string and two numbers; it is removed anyway, because "deleted immediately"
   * should not have a footnote about a cooldown table (review round 1, M4).
   */
  forgetViewer(channelRef: string): void {
    this.#viewers.delete(channelRef)
  }

  /**
   * Returns the windows that closed since the last call and clears them. The
   * engine (T8) turns each into a single state transition, which is what keeps
   * a flood from becoming one transition per message.
   */
  drainClosedWindows(): AggregateWindowResult[] {
    this.#sync()
    const drained = this.#closed
    this.#closed = []
    return drained
  }

  /**
   * The open window in the contract's shape, for `WorldSnapshot.display`
   * (spec §5.2, §6.4: mode, remaining time and tallies are on screen).
   */
  currentWindow(): AggregateWindow {
    this.#sync()
    // The screen shows contributions, not bookkeeping: both halves are summed
    // so a viewer sees everything the window received (spec §5.2, §6.4).
    const contributions = (name: CommandName): number =>
      this.#counts[name].directApplied + this.#counts[name].aggregatedOnly
    return {
      mode: this.#mode,
      endsAt: this.#instantAt(this.#windowEndMonotonicMs()),
      tallies: CommandNameSchema.options
        .filter((name) => contributions(name) > 0)
        .map((name) => ({ commandName: name, count: contributions(name) })),
    }
  }

  /** Milliseconds left in the open window; for the on-screen countdown. */
  remainingMs(): number {
    this.#sync()
    return this.#windowEndMonotonicMs() - this.#clock.monotonicMs()
  }

  #sync(): void {
    const elapsed = this.#clock.monotonicMs() - this.#baseMonotonicMs
    const target = Math.floor(elapsed / this.#config.windowMs)
    if (target <= this.#windowIndex) {
      return
    }
    this.#closeWindow()
    if (target > this.#windowIndex + 1) {
      // Windows in between saw no input at all. There is no contribution to
      // preserve, so no result is emitted for them — but an idle stretch is
      // exactly what returns the arbiter to `direct`.
      this.#mode = this.#nextMode(0)
    }
    this.#windowIndex = target
    this.#resetCounters()
  }

  #closeWindow(): void {
    const nextMode = this.#nextMode(this.#accepted)
    if (this.#accepted > 0) {
      const startMs = this.#baseMonotonicMs + this.#windowIndex * this.#config.windowMs
      this.#closed.push({
        sequence: this.#windowIndex,
        mode: this.#mode,
        startedAtUtc: this.#instantAt(startMs),
        endedAtUtc: this.#instantAt(startMs + this.#config.windowMs),
        counts: freezeCounts(this.#counts),
        acceptedCount: this.#accepted,
        directAppliedCount: this.#directApplied,
        aggregatedCount: this.#aggregated,
        nextMode,
      })
    }
    this.#mode = nextMode
  }

  /** Hysteresis: entering needs a burst, leaving needs a quiet window. */
  #nextMode(acceptedCount: number): InputMode {
    if (this.#mode === 'direct') {
      return acceptedCount >= this.#config.enterAggregateAtCommands ? 'aggregate' : 'direct'
    }
    return acceptedCount <= this.#config.exitAggregateAtCommands ? 'direct' : 'aggregate'
  }

  #resetCounters(): void {
    this.#pruneViewers()
    this.#counts = emptyCounts()
    this.#accepted = 0
    this.#directApplied = 0
    this.#aggregated = 0
  }

  #windowEndMonotonicMs(): number {
    return this.#baseMonotonicMs + (this.#windowIndex + 1) * this.#config.windowMs
  }

  #instantAt(monotonicMs: number): string {
    return new Date(this.#baseEpochMs + (monotonicMs - this.#baseMonotonicMs)).toISOString()
  }
}

const VOTE_COMMANDS: ReadonlySet<CommandName> = new Set(['VOTE_A', 'VOTE_B', 'VOTE_C'])

function isVote(name: CommandName): boolean {
  return VOTE_COMMANDS.has(name)
}
