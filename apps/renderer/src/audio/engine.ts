import { MASTER_GAIN, bellHz, type AudioScore } from './score'

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
 * A drone, a filter and a slow bell, following whatever score it is given.
 *
 * The bell is scheduled one at a time rather than on a fixed grid: the interval
 * moves with the world, and a grid laid out in advance would keep playing the
 * old weather's pace for as long as it had been scheduled for.
 */
export class AmbientAudio {
  #context: AudioContext | null = null
  #master: GainNode | null = null
  #filter: BiquadFilterNode | null = null
  #droneGain: GainNode | null = null
  #voices: OscillatorNode[] = []
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
      this.#scheduleBell()
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
    const voices = this.#voices
    this.#voices = []
    this.#context = null
    this.#master = null
    this.#filter = null
    this.#droneGain = null
    if (context === null) return

    if (master !== null) {
      const at = context.currentTime
      master.gain.cancelScheduledValues(at)
      master.gain.setValueAtTime(master.gain.value, at)
      master.gain.linearRampToValueAtTime(0, at + FADE_OUT_SEC)
    }
    setTimeout(
      () => {
        for (const voice of voices) {
          try {
            voice.stop()
          } catch {
            // Already stopped; nothing to undo.
          }
        }
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

    const droneGain = context.createGain()
    droneGain.gain.setValueAtTime(score.droneGain, context.currentTime)
    droneGain.connect(filter)

    // Root and fifth, each doubled and detuned: the beating between the pairs is
    // what keeps a held chord from sounding like a test tone.
    for (const [ratio, detune] of [
      [1, -score.droneDetuneCents],
      [1, score.droneDetuneCents],
      [1.5, -score.droneDetuneCents],
      [2, score.droneDetuneCents],
    ] as const) {
      const osc = context.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(score.rootHz * ratio, context.currentTime)
      osc.detune.setValueAtTime(detune, context.currentTime)
      osc.connect(droneGain)
      osc.start()
      this.#voices.push(osc)
    }

    this.#master = master
    this.#filter = filter
    this.#droneGain = droneGain
  }

  #retune(context: AudioContext, score: AudioScore): void {
    const at = context.currentTime
    this.#filter?.frequency.linearRampToValueAtTime(score.cutoffHz, at + RAMP_SEC)
    this.#droneGain?.gain.linearRampToValueAtTime(score.droneGain, at + RAMP_SEC)
    for (const [index, voice] of this.#voices.entries()) {
      const ratio = [1, 1, 1.5, 2][index] ?? 1
      voice.frequency.linearRampToValueAtTime(score.rootHz * ratio, at + RAMP_SEC)
    }
  }

  #scheduleBell(): void {
    if (this.#stopped) return
    const score = this.#score
    const context = this.#context
    if (score === null || context === null) return
    this.#timer = setTimeout(
      () => {
        this.#ringBell()
        this.#scheduleBell()
      },
      Math.round(score.bellIntervalSec * 1000),
    )
  }

  #ringBell(): void {
    const context = this.#context
    const filter = this.#filter
    const score = this.#score
    if (context === null || filter === null || score === null) return

    const at = context.currentTime
    const osc = context.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(bellHz(score, this.#step), at)

    // Percussive envelope: no attack click, a long tail that overlaps the next
    // bell at every interval the score can produce.
    const gain = context.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(score.bellGain, at + 0.08)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 3.2)

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
