import {
  CommandNameSchema,
  type AggregateWindow,
  type CommandName,
  type CommandRef,
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
 * There is deliberately **no per-user cooldown and no one-vote-per-user rule**:
 * `actor` is `null` while the identity gate is closed (spec §7.4, BOARD A-1),
 * so a per-user claim would be a claim we cannot back. Spec §6.4 says as much —
 * this mode may not claim per-user fairness.
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

/** What the arbiter decided for one accepted command. */
export interface ArbiterAdmission {
  /** `direct` = apply in order; `aggregated` = counted in the window tally only. */
  readonly disposition: 'direct' | 'aggregated'
  /** Mode of the window the command landed in. */
  readonly mode: InputMode
  readonly command: CommandRef
  readonly windowSequence: number
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

export class InputArbiter {
  readonly #clock: Clock
  readonly #config: InputWindowConfig
  readonly #baseMonotonicMs: number
  readonly #baseEpochMs: number

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
    this.#clock = options.clock
    this.#config = options.config
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
   */
  admit(command: CommandRef): ArbiterAdmission {
    this.#sync()
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
    return {
      disposition: applyDirectly ? 'direct' : 'aggregated',
      mode: this.#mode,
      command,
      windowSequence: this.#windowIndex,
    }
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
