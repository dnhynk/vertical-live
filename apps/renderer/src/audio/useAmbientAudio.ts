import { useEffect, useRef } from 'react'

import { useReadModel } from '../hooks'
import type { RendererRuntime } from '../runtime'
import { sceneConditions } from '../visual/palette'
import { AmbientAudio } from './engine'
import { scoreFor } from './score'

/**
 * Plays the generated bed for whatever world the snapshot describes.
 *
 * It reads `sceneConditions` — the same derivation the palette colours the room
 * from — so the sound and the picture can never describe different weather.
 *
 * The effect body deliberately does nothing but forward a score. `scoreFor` is
 * pure and `AmbientAudio.apply` ignores a score it is already playing, so this
 * running on every tick costs a string comparison.
 */
export function useAmbientAudio(runtime: RendererRuntime): void {
  const { snapshot } = useReadModel(runtime.model)
  const audioRef = useRef<AmbientAudio | null>(null)
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
}
