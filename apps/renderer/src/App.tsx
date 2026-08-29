import { useAmbientAudio } from './audio/useAmbientAudio'
import Scene from './components/Scene'
import Screen from './components/Screen'
import Stage from './components/Stage'
import type { RendererRuntime } from './runtime'

/**
 * T5 renderer: a read model of the server's world state (spec §10.2).
 *
 * It owns no state, keeps nothing locally, and recovers from a refresh with the
 * server snapshot alone. The prototype game store, its local test panel and its
 * broadcast overlay live in `legacy/renderer-prototype/` and are not on the
 * product path (spec §10.4).
 */
export interface AppProps {
  runtime: RendererRuntime
}

export default function App({ runtime }: AppProps) {
  // Atmosphere only: spec §5.2 is a five-second test with the sound off, so
  // nothing here is the only place anything is said (`audio/score.ts`).
  useAmbientAudio(runtime)

  return (
    <Stage>
      <Scene runtime={runtime} />
      <Screen runtime={runtime} />
    </Stage>
  )
}
