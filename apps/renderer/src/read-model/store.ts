import type { Effect, EffectId, IsoUtcInstant, WorldSnapshot } from '@vl/contract'

import type { Clock } from './clock'
import type { RendererLog } from './log'

/**
 * The renderer's read model (spec §10.2, §7.3(6)(7)).
 *
 * It holds exactly what the server sent and nothing it derived itself: no game
 * rules, no names, no revenue totals, no local persistence. A refresh starts
 * empty and is recovered from the next `snapshot` alone.
 *
 * ACK ordering is the point of this class. A revision or an effect is only
 * acknowledged once it has (1) been committed by React and (2) survived a
 * `requestAnimationFrame` callback, which the HTML standard schedules right
 * before the repaint that shows it. That is what spec §7.3(7) means by "the
 * revision the renderer actually drew".
 */

export type SnapshotOutcome = 'applied' | 'stale'
/** `expired` = the effect window had already closed on arrival (spec §9.2). */
export type EffectOutcome = 'started' | 'repeat' | 'expired'

export interface AckSink {
  ackState(stateRevision: number, appliedAt: IsoUtcInstant): void
  ackEffect(effectId: EffectId, appliedAt: IsoUtcInstant): void
}

export interface ReadModelOptions {
  clock: Clock
  log: RendererLog
  /** How long a finished `effectId` is remembered so a resend cannot restart it. */
  effectRetentionMs?: number
  /** Hard cap on remembered effect ids: a 72h run must not grow without bound. */
  maxRememberedEffects?: number
}

interface TrackedEffect {
  readonly effect: Effect
  readonly startsAtMs: number
  readonly endsAtMs: number
  displayed: boolean
}

/** Provisional (BOARD A-15): no spec value; replaced by an approved number. */
export const DEFAULT_EFFECT_RETENTION_MS = 600_000
/** Provisional (BOARD A-15). */
export const DEFAULT_MAX_REMEMBERED_EFFECTS = 512

export class ReadModel {
  readonly #clock: Clock
  readonly #log: RendererLog
  readonly #effectRetentionMs: number
  readonly #maxRememberedEffects: number

  #snapshot: WorldSnapshot | null = null
  /** Received, not yet committed by React. */
  #pendingStateRevision: number | null = null
  /** Committed by React, not yet seen by a frame callback. */
  #committedStateRevision: number | null = null
  /** Drawn and acknowledged; this is what `hello` and `renderer_health` report. */
  #ackedStateRevision: number | null = null
  #ackedEffectId: EffectId | null = null

  readonly #effects = new Map<EffectId, TrackedEffect>()
  /** Effect ids whose ACK is waiting for a React commit. */
  readonly #pendingEffectAcks = new Set<EffectId>()
  /** Effect ids committed and waiting for the frame that shows them. */
  readonly #committedEffectAcks = new Set<EffectId>()
  /**
   * The active effects of the last committed render. An effect is only
   * acknowledged once a commit has actually carried it onto the screen, so
   * becoming active and being acknowledged can never happen in one step.
   */
  #committedActiveEffectIds: ReadonlySet<EffectId> = new Set()

  #activeEffects: readonly Effect[] = []
  #effectStartCount = 0
  #version = 0

  #sink: AckSink | null = null
  readonly #listeners = new Set<() => void>()

  constructor(options: ReadModelOptions) {
    this.#clock = options.clock
    this.#log = options.log
    this.#effectRetentionMs = options.effectRetentionMs ?? DEFAULT_EFFECT_RETENTION_MS
    this.#maxRememberedEffects = options.maxRememberedEffects ?? DEFAULT_MAX_REMEMBERED_EFFECTS
  }

  setAckSink(sink: AckSink | null): void {
    this.#sink = sink
  }

  // --- projection ---------------------------------------------------------

  get snapshot(): WorldSnapshot | null {
    return this.#snapshot
  }

  get activeEffects(): readonly Effect[] {
    return this.#activeEffects
  }

  get lastAppliedStateRevision(): number | null {
    return this.#ackedStateRevision
  }

  get lastAppliedEffectId(): EffectId | null {
    return this.#ackedEffectId
  }

  /** How many distinct effects were started; a resend must not increase it. */
  get effectStartCount(): number {
    return this.#effectStartCount
  }

  /** Changes whenever the projection changes; `useSyncExternalStore` reads it. */
  get version(): number {
    return this.#version
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // --- server messages ----------------------------------------------------

  /** Whole-snapshot replacement (spec §7.3(6)); an older revision is dropped. */
  receiveSnapshot(snapshot: WorldSnapshot): SnapshotOutcome {
    const newest = Math.max(
      this.#snapshot?.stateRevision ?? -1,
      this.#pendingStateRevision ?? -1,
      this.#committedStateRevision ?? -1,
      this.#ackedStateRevision ?? -1,
    )
    if (snapshot.stateRevision < newest) {
      this.#log.warn('snapshot_stale', snapshot.stateRevision)
      return 'stale'
    }

    this.#snapshot = snapshot
    this.#pendingStateRevision = snapshot.stateRevision
    this.#refreshActiveEffects()
    this.#notify()
    return 'applied'
  }

  /**
   * Starts an effect at most once (spec §7.3(7)). A resend is not replayed, but
   * it is acknowledged again: the server only resends when it holds no ACK.
   */
  receiveEffect(effect: Effect): EffectOutcome {
    const now = this.#clock.wallMs()
    const known = this.#effects.get(effect.effectId)
    const endsAtMs = known?.endsAtMs ?? Date.parse(effect.endsAt)

    if (endsAtMs <= now) {
      if (known === undefined) {
        this.#effects.set(effect.effectId, {
          effect,
          startsAtMs: Date.parse(effect.startsAt),
          endsAtMs,
          displayed: false,
        })
        this.#log.warn('effect_window_closed', effect.effectId)
      }
      this.#pendingEffectAcks.delete(effect.effectId)
      this.#committedEffectAcks.delete(effect.effectId)
      return 'expired'
    }

    if (known !== undefined) {
      // A resend changes nothing on screen, so React has no reason to render
      // and `markCommitted` may never run again. Queueing the ACK behind a
      // commit would strand it, so a copy whose original has already been
      // committed goes straight into the frame queue; only a copy that is still
      // waiting for its first commit stays pending (spec §7.3(7)).
      if (!this.#pendingEffectAcks.has(effect.effectId)) {
        this.#committedEffectAcks.add(effect.effectId)
      }
      this.#log.info('effect_repeat', effect.effectId)
      return 'repeat'
    }

    this.#effects.set(effect.effectId, {
      effect,
      startsAtMs: Date.parse(effect.startsAt),
      endsAtMs,
      displayed: false,
    })
    this.#effectStartCount += 1
    this.#pendingEffectAcks.add(effect.effectId)
    this.#refreshActiveEffects()
    this.#notify()
    return 'started'
  }

  // --- frame lifecycle ----------------------------------------------------

  /** Called from a React commit: what is on screen now is what is in the model. */
  markCommitted(): void {
    if (this.#pendingStateRevision !== null) {
      this.#committedStateRevision = this.#pendingStateRevision
      this.#pendingStateRevision = null
    }
    for (const effectId of this.#pendingEffectAcks) this.#committedEffectAcks.add(effectId)
    this.#pendingEffectAcks.clear()
    // What this commit put on screen. The frame loop acknowledges an effect
    // only if the committed render contained it.
    this.#committedActiveEffectIds = new Set(this.#activeEffects.map((effect) => effect.effectId))
  }

  /**
   * Called from the `requestAnimationFrame` loop, i.e. after the browser has
   * painted the committed render. Only here does an ACK leave the renderer.
   */
  markFramePresented(): void {
    const now = this.#clock.wallMs()
    const appliedAt = this.#clock.nowIso()

    if (
      this.#committedStateRevision !== null &&
      this.#committedStateRevision !== this.#ackedStateRevision
    ) {
      this.#ackedStateRevision = this.#committedStateRevision
      this.#committedStateRevision = null
      this.#sink?.ackState(this.#ackedStateRevision, appliedAt)
    }

    for (const effectId of [...this.#committedEffectAcks]) {
      const tracked = this.#effects.get(effectId)
      if (tracked === undefined) {
        this.#committedEffectAcks.delete(effectId)
        continue
      }
      if (now >= tracked.endsAtMs) {
        // Never shown, so it is not acknowledged as applied: the server records
        // the expiry instead and runs the substitute thanks effect (spec §9.2).
        this.#committedEffectAcks.delete(effectId)
        this.#log.warn('effect_expired_before_frame', effectId)
        continue
      }
      if (now < tracked.startsAtMs) continue
      if (!this.#committedActiveEffectIds.has(effectId)) {
        // The window has opened but no committed render has carried the effect
        // yet. `#refreshActiveEffects` below notifies React; the ACK goes out on
        // the frame after that commit, never on the frame that activates it
        // (spec §7.3(7)).
        continue
      }

      tracked.displayed = true
      this.#committedEffectAcks.delete(effectId)
      this.#ackedEffectId = effectId
      this.#sink?.ackEffect(effectId, appliedAt)
    }

    this.#pruneEffects(now)
    this.#refreshActiveEffects()
  }

  // --- internals ----------------------------------------------------------

  #refreshActiveEffects(): void {
    const now = this.#clock.wallMs()
    const active: Effect[] = []
    for (const tracked of this.#effects.values()) {
      if (now >= tracked.startsAtMs && now < tracked.endsAtMs) active.push(tracked.effect)
    }
    const changed =
      active.length !== this.#activeEffects.length ||
      active.some((effect, index) => this.#activeEffects[index]?.effectId !== effect.effectId)
    if (!changed) return
    this.#activeEffects = active
    this.#notify()
  }

  #pruneEffects(now: number): void {
    for (const [effectId, tracked] of this.#effects) {
      if (tracked.endsAtMs + this.#effectRetentionMs <= now) this.#effects.delete(effectId)
    }
    if (this.#effects.size <= this.#maxRememberedEffects) return
    // Map iteration is insertion-ordered, so this drops the oldest arrivals.
    const excess = this.#effects.size - this.#maxRememberedEffects
    let dropped = 0
    for (const [effectId, tracked] of this.#effects) {
      if (dropped >= excess) break
      if (now < tracked.endsAtMs) continue
      this.#effects.delete(effectId)
      dropped += 1
    }
    if (dropped > 0) this.#log.warn('effect_memory_pruned', dropped)
  }

  #notify(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}
