import { Suspense, useEffect, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import type { CommandName, Effect } from '@vl/contract'

import { useReadModel } from '../hooks'
import type { RendererRuntime } from '../runtime'
import { paletteFor } from '../visual/palette'
import { createContactShadowTexture } from '../visual/shadow-texture'
import Background from './Background'
import Pet from './Pet'

/**
 * The R3F layer of the stage. `dpr={1}` keeps the drawing buffer at the
 * broadcast resolution instead of the developer monitor's device pixel ratio.
 *
 * Light and colour follow the world (spec §12.5): the palette is derived from
 * the snapshot's time of day, place, weather, chapter and mood, so the same
 * command lands in a visibly different room at dawn in the rain than it does on
 * a clear afternoon.
 *
 * The canvas is handed to the WebGL context tracker as soon as it exists, so a
 * `webglcontextlost` on air is reported in `renderer_health` and a restore is
 * requested (spec §9.4(4)).
 */
export interface SceneProps {
  runtime: RendererRuntime
}

function reactingCommand(effects: readonly Effect[]): CommandName | null {
  for (const effect of effects) {
    if (effect.kind === 'ACTION_REACTION') return effect.payload.commandName
  }
  return null
}

export default function Scene({ runtime }: SceneProps) {
  const { snapshot, activeEffects } = useReadModel(runtime.model)
  const palette = paletteFor(snapshot)
  const resting = snapshot?.display.currentNeedOrMission.textKey.startsWith('crisis.') ?? false
  const shadow = useMemo(() => createContactShadowTexture(), [])

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
      <ambientLight color={palette.ambientColor} intensity={palette.ambientIntensity} />
      <directionalLight
        position={[6, 8, 5]}
        color={palette.keyColor}
        intensity={palette.keyIntensity}
      />
      <pointLight
        position={[-3, 1.5, 3]}
        color={palette.rimColor}
        intensity={palette.rimIntensity * 2}
        distance={14}
      />
      {/*
        Back rim. The creature and the ridges behind it are both mid-value, so
        without a light from behind the silhouette dissolves into the scene at
        phone size — this is the one light that keeps the shape readable
        (spec §5.2 five seconds, §14.2(1) real mobile UI).
      */}
      <pointLight
        position={[0, 2.4, -3.2]}
        color={palette.rimColor}
        intensity={palette.rimIntensity * 3.2}
        distance={11}
      />

      <Background palette={palette} />

      {/* Contact shadow: without it the creature floats in the gradient. */}
      <mesh position={[0, 0.28, -0.3]} rotation={[-1.24, 0, 0]} scale={[1.7, 1.2, 1]}>
        <planeGeometry args={[1.6, 1.6]} />
        <meshBasicMaterial map={shadow} transparent depthWrite={false} />
      </mesh>

      <Suspense fallback={null}>
        <Pet
          growthStage={snapshot?.creature.growthStage ?? ''}
          emotionId={snapshot?.creature.emotionId ?? ''}
          reaction={reactingCommand(activeEffects)}
          resting={resting}
        />
      </Suspense>
    </Canvas>
  )
}
