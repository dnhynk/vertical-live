import { useEffect, useRef } from 'react'

import { useReadModel } from '../hooks'
import type { RendererRuntime } from '../runtime'
import { sceneConditions } from '../visual/palette'
import { AmbientAudio } from './engine'
import { scoreFor } from './score'

/**
 * Plays the generated bed for whatever world the snapshot describes, and rings
 * once for each command the world applies.
 *
 * It reads `sceneConditions` — the same derivation the palette colours the room
 * from — so the sound and the picture can never describe different weather.
 *
 * The score effect deliberately does nothing but forward a score. `scoreFor` is
 * pure and `AmbientAudio.apply` ignores a score it is already playing, so this
 * running on every tick costs a string comparison.
 */
export function useAmbientAudio(runtime: RendererRuntime): void {
  const { snapshot, activeEffects } = useReadModel(runtime.model)
  const audioRef = useRef<AmbientAudio | null>(null)
  const rungRef = useRef<Set<string>>(new Set())
  const enabled = runtime.config.audioEnabled

  useEffect(() => {
    if (!enabled) return undefined
    const audio = new AmbientAudio()
    audioRef.current = audio
    // A browser source usually allows autoplay; when it does not, this is the
    // one place that finds out, and `state` says so rather than pretending.
    void audio.resume()
    return () => {
      audioRef.current = null
      audio.stop()
    }
  }, [enabled])

  useEffect(() => {
    if (snapshot === null) return
    audioRef.current?.apply(scoreFor(sceneConditions(snapshot)))
  }, [snapshot])

  /**
   * One ring per effect, not per render.
   *
   * An effect stays in `activeEffects` for its whole staging window, so ringing
   * on what is currently active would ring on every tick for as long as the
   * animation lasts. `effectId` is the idempotency unit the contract already
   * uses for exactly this reason (spec §7.3(6)), so it is what is remembered.
   *
   * The set is pruned to the effects still on screen. It cannot grow without
   * bound over a 24-hour run, and an id cannot come back after it has left —
   * the server issues each one once.
   */
  useEffect(() => {
    const audio = audioRef.current
    const rung = rungRef.current
    const live = new Set<string>()
    for (const effect of activeEffects) {
      live.add(effect.effectId)
      if (effect.kind !== 'ACTION_REACTION') continue
      if (rung.has(effect.effectId)) continue
      rung.add(effect.effectId)
      audio?.ring(effect.payload.commandName)
    }
    for (const id of rung) if (!live.has(id)) rung.delete(id)
  }, [activeEffects])
}
