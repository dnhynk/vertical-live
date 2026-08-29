import { Suspense, useEffect, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import type { CommandName, Effect } from '@vl/contract'

import { STAGE_WIDTH } from '../config'
import { useReadModel } from '../hooks'
import type { RendererRuntime } from '../runtime'
import { paletteFor } from '../visual/palette'
import { RAIL_WIDTH, SAFE_BAND, SAFE_INSET_X } from '../visual/safe-area'
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

/** Camera, stated rather than defaulted, because the placement below is calibrated against it. */
const CAMERA_Z = 5
const CAMERA_FOV_DEG = 75

/**
 * How far one world unit travels across the frame at the creature's depth.
 *
 * Measured, not derived: two captures of the same preview state at group offsets
 * `0` and `(-0.2398, 0.8293)` moved the creature 216 rows and 64 columns, which
 * is 260.5 px per unit in both axes. Deriving it from the field of view alone
 * gives 250, and the 4% gap is what the difference between a right head and a
 * head under the app's header scrim is made of.
 */
const PIXELS_PER_WORLD_UNIT = 260.5

/**
 * Where the creature's crown lands with no offset applied, in the same capture.
 * Re-measure with `apps/renderer/scripts/capture.mjs` if the creature's build
 * changes; nothing else here needs to move.
 */
const CROWN_AT_REST_PX = 413

/** Gap we want between the app's header scrim and the creature's crown. */
const CROWN_CLEARANCE_PX = 120

/** Gap we want between the creature's right edge and the rail's left edge. */
const RAIL_CLEARANCE_PX = 40

/** Right edge of the creature at rest, from the same capture. */
const RIGHT_EDGE_AT_REST_PX = 707

/**
 * The creature is composed on the frame's centre. The frame's centre is not what
 * a viewer sees: the app draws its header over the top rows and its chat over the
 * bottom ones, so composing there puts the head under the scrim. Lift it until
 * the crown clears the header, and step it left until it clears the rail — no
 * further, because the app stacks its own gift labels down the left edge and
 * moving further trades one overlap for another.
 */
const STAGE_LIFT = (CROWN_AT_REST_PX - (SAFE_BAND.top + CROWN_CLEARANCE_PX)) / PIXELS_PER_WORLD_UNIT

const RAIL_LEFT_PX = STAGE_WIDTH - SAFE_INSET_X - RAIL_WIDTH
const STAGE_SHIFT_X =
  -Math.max(0, RIGHT_EDGE_AT_REST_PX - (RAIL_LEFT_PX - RAIL_CLEARANCE_PX)) / PIXELS_PER_WORLD_UNIT

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
      camera={{ position: [0, 0, CAMERA_Z], fov: CAMERA_FOV_DEG }}
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

      {/*
        The creature and its contact shadow move together: the shadow is what
        stops it floating in the gradient, so it has to follow the lift.
      */}
      <group position={[STAGE_SHIFT_X, STAGE_LIFT, 0]}>
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
      </group>
    </Canvas>
  )
}
