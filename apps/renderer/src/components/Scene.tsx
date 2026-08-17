import { Suspense, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import type { CommandName } from '@vl/contract'

import { useReadModel } from '../hooks'
import type { RendererRuntime } from '../runtime'
import Background from './Background'
import Pet from './Pet'

/**
 * The R3F layer of the stage. `dpr={1}` keeps the drawing buffer at the
 * broadcast resolution instead of the developer monitor's device pixel ratio.
 *
 * The canvas is handed to the WebGL context tracker as soon as it exists, so a
 * `webglcontextlost` on air is reported in `renderer_health` and a restore is
 * requested (spec §9.4(4)).
 */
export interface SceneProps {
  runtime: RendererRuntime
}

function reactingCommand(runtime: RendererRuntime): CommandName | null {
  for (const effect of runtime.model.activeEffects) {
    if (effect.kind === 'ACTION_REACTION') return effect.payload.commandName
  }
  return null
}

export default function Scene({ runtime }: SceneProps) {
  useReadModel(runtime.model)
  const command = reactingCommand(runtime)

  useEffect(() => {
    return () => {
      runtime.webgl.detach()
    }
  }, [runtime])

  return (
    <Canvas
      className="stage-canvas"
      dpr={1}
      camera={{ position: [0, 0, 5] }}
      onCreated={({ gl }) => {
        runtime.webgl.attach(gl.domElement)
      }}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[10, 10, 5]} intensity={1.1} />
      <pointLight position={[-3, 2, 3]} intensity={1.2} color="#7dd3fc" />

      <Background />

      <Suspense fallback={null}>
        <Pet isEating={command === 'FEED'} />
      </Suspense>
    </Canvas>
  )
}
