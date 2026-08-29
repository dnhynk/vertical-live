import { CHIME_GAIN, MASTER_GAIN, chimeHzFor, noteHz, type AudioScore } from './score'

/**
 * The Web Audio wiring for `score.ts`. Every decision about what to play lives
 * there; this file only builds the graph and moves parameters toward it.
 *
 * Two things it must never do:
 *
 * - **Throw where there is no audio.** The renderer runs under jsdom in tests,
 *   and a browser source can be opened somewhere without an `AudioContext`. A
 *   missing one is a state, not a fault: the screen is the product and spec §5.2
 *   requires it to work with the sound off anyway, so this degrades to silence
 *   and reports it.
 * - **Jump.** Every parameter moves with a ramp. A step change in a filter or a
 *   gain is a click, and a click on a 24-hour stream is worse than any amount of
 *   the wrong timbre.
 *
 * All sound is generated from oscillators here and now. No file is loaded, no
 * sample is bundled, nothing third-party is involved (`ASSETS.md`).
 */

/** Seconds a parameter takes to reach a new value. Long enough that nothing steps. */
const RAMP_SEC = 2.5

/** Fade applied when the graph starts, so a reload does not begin with a click. */
const FADE_IN_SEC = 4

/** Fade applied on stop, so a reload does not end with one either. */
const FADE_OUT_SEC = 0.4

type AudioContextCtor = new () => AudioContext

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return scope.AudioContext ?? scope.webkitAudioContext ?? null
}

export type AmbientState = 'unsupported' | 'suspended' | 'running' | 'stopped'

/**
 * A filter, a slow note and a chime, following whatever score it is given.
 *
 * There is no sustained voice. The graph holds nothing between events, so when
 * nothing is happening the stream carries silence — which is what the first
 * version got wrong, and no amount of choosing a nicer chord fixed.
 *
 * The note is scheduled one at a time rather than on a fixed grid: the interval
 * moves with the world, and a grid laid out in advance would keep playing the
 * old weather's pace for as long as it had been scheduled for.
 */
export class AmbientAudio {
  #context: AudioContext | null = null
  #master: GainNode | null = null
  #filter: BiquadFilterNode | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #score: AudioScore | null = null
  #step = 0
  #stopped = false

  get state(): AmbientState {
    if (this.#stopped) return 'stopped'
    if (this.#context === null) return 'unsupported'
    return this.#context.state === 'running' ? 'running' : 'suspended'
  }

  /** Current score's id, or `null` before the first one. Lets a caller skip no-op work. */
  get scoreId(): string | null {
    return this.#score?.scoreId ?? null
  }

  /**
   * Applies a score, building the graph on the first call.
   *
   * Safe to call with the same score repeatedly: only the parameters that differ
   * are ramped, and the bell keeps its own schedule either way.
   */
  apply(score: AudioScore): void {
    if (this.#stopped) return
    const context = this.#ensureContext()
    if (context === null) {
      this.#score = score
      return
    }
    const previous = this.#score
    this.#score = score
    if (previous === null) {
      this.#build(context, score)
      this.#scheduleNote()
      return
    }
    if (previous.scoreId === score.scoreId) return
    this.#retune(context, score)
  }

  /**
   * Asks a suspended context to start.
   *
   * Browsers gate audio behind a gesture. OBS's browser source normally allows
   * autoplay, but "normally" is not a guarantee, so this is callable again later
   * and reports what happened rather than assuming.
   */
  async resume(): Promise<AmbientState> {
    const context = this.#context
    if (context === null || this.#stopped) return this.state
    if (context.state !== 'running') {
      try {
        await context.resume()
      } catch {
        // A refused resume is not an error worth breaking the screen over.
      }
    }
    return this.state
  }

  /**
   * Fades out and releases the context. The instance does not restart.
   *
   * The fade is the point: cutting a held drone at full gain is a click, and on
   * a live broadcast a reload would put one on air every time.
   */
  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const context = this.#context
    const master = this.#master
    this.#context = null
    this.#master = null
    this.#filter = null
    if (context === null) return

    if (master !== null) {
      const at = context.currentTime
      master.gain.cancelScheduledValues(at)
      master.gain.setValueAtTime(master.gain.value, at)
      master.gain.linearRampToValueAtTime(0, at + FADE_OUT_SEC)
    }
    setTimeout(
      () => {
        void context.close().catch(() => {})
      },
      Math.round(FADE_OUT_SEC * 1000) + 50,
    )
  }

  #ensureContext(): AudioContext | null {
    if (this.#context !== null) return this.#context
    const Ctor = audioContextCtor()
    if (Ctor === null) return null
    try {
      this.#context = new Ctor()
    } catch {
      this.#context = null
    }
    return this.#context
  }

  #build(context: AudioContext, score: AudioScore): void {
    const master = context.createGain()
    master.gain.setValueAtTime(0, context.currentTime)
    master.gain.linearRampToValueAtTime(MASTER_GAIN, context.currentTime + FADE_IN_SEC)
    master.connect(context.destination)

    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(score.cutoffHz, context.currentTime)
    filter.Q.setValueAtTime(0.6, context.currentTime)
    filter.connect(master)

    this.#master = master
    this.#filter = filter
  }

  #retune(context: AudioContext, score: AudioScore): void {
    // Only the filter is held between events; everything else is created per
    // note and per chime, so there is nothing else to move.
    this.#filter?.frequency.linearRampToValueAtTime(score.cutoffHz, context.currentTime + RAMP_SEC)
  }

  /**
   * Rings once for a command that just landed.
   *
   * The caller decides *when* — one ring per effect, never per render. This only
   * refuses what should never ring: a stopped instance, a silent one, and any
   * command that is not one of the free care commands (spec §8.5).
   */
  ring(commandName: string): void {
    const context = this.#context
    const filter = this.#filter
    const score = this.#score
    if (this.#stopped || context === null || filter === null || score === null) return
    const hz = chimeHzFor(score, commandName)
    if (hz === null) return

    const at = context.currentTime
    const osc = context.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(hz, at)

    const gain = context.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(CHIME_GAIN, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.1)

    osc.connect(gain)
    gain.connect(filter)
    osc.start(at)
    osc.stop(at + 1.2)
    osc.onended = (): void => {
      osc.disconnect()
      gain.disconnect()
    }
  }

  #scheduleNote(): void {
    if (this.#stopped) return
    const score = this.#score
    const context = this.#context
    if (score === null || context === null) return
    this.#timer = setTimeout(
      () => {
        this.#ringNote()
        this.#scheduleNote()
      },
      Math.round(score.noteIntervalSec * 1000),
    )
  }

  #ringNote(): void {
    const context = this.#context
    const filter = this.#filter
    const score = this.#score
    if (context === null || filter === null || score === null) return

    const at = context.currentTime
    const osc = context.createOscillator()
    // Sine, not triangle: the triangle's upper partials are what made this read
    // as a bell in an empty building rather than as a soft tone in a room.
    osc.type = 'sine'
    osc.frequency.setValueAtTime(noteHz(score, this.#step), at)

    // Slow in, slow out. The first version's fast attack and three-second tail
    // was a struck bell; this is closer to a breath.
    const gain = context.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(score.noteGain, at + 0.5)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 2.6)

    osc.connect(gain)
    gain.connect(filter)
    osc.start(at)
    osc.stop(at + 3.4)
    osc.onended = (): void => {
      osc.disconnect()
      gain.disconnect()
    }
    this.#step += 1
  }
}
