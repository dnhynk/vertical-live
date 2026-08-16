import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import Background from './components/Background'
import Pet from './components/Pet'

/**
 * T0 renderer: the 9:16 R3F scene and nothing else.
 *
 * The renderer is a read model (spec §10.2) — it owns no state. Snapshot/effect
 * transport, the four fixed display fields (§5.2) and i18n arrive in T5/T14.
 * The prototype game store, local test panel and broadcast overlay were moved to
 * `legacy/renderer-prototype/` and are not on the product path (spec §10.4).
 */
export default function App() {
  return (
    <div className="app-shell">
      <div className="stage" aria-label="9:16 scene">
        <Canvas className="stage-canvas" camera={{ position: [0, 0, 5] }}>
          <ambientLight intensity={0.55} />
          <directionalLight position={[10, 10, 5]} intensity={1.1} />
          <pointLight position={[-3, 2, 3]} intensity={1.2} color="#7dd3fc" />

          <Background />

          <Suspense fallback={null}>
            <Pet />
          </Suspense>
        </Canvas>
      </div>
    </div>
  )
}
