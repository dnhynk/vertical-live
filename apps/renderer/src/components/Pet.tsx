import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { CommandName } from '@vl/contract'

/**
 * The creature, built from primitives written in this repository.
 *
 * It is an original design: a rounded body, a soft crest that grows with the
 * creature and a small tail. Nothing about the silhouette, the markings or the
 * colours is taken from anything — spec §12.1 and CLAUDE.md §3 forbid
 * third-party characters and assets of unclear rights, and the prototype's
 * `pet.glb` turned out to be exactly that (it now sits in
 * `legacy/renderer-prototype/`, off the product path). `ASSETS.md` records this
 * geometry as self-made.
 *
 * The shape follows the growth ladder (spec §6.3): the creature only ever gains
 * parts, and there is no stage that looks damaged or dying, because the world
 * has none (spec §6.3 — no death, no permanent regression).
 *
 * Everything here is presentation driven by props. The renderer owns no state
 * (spec §10.2): the growth stage, the mood and the reaction all arrive from the
 * server's snapshot and effects.
 */

const BODY_COLOR = '#f3ddb0'
const MARK_COLOR = '#6fae9b'
const EYE_COLOR = '#2b2118'
const SHELL_COLOR = '#e8e2d2'

interface CreatureBuild {
  readonly scale: number
  readonly bodyRadius: number
  readonly headRadius: number
  readonly hatched: boolean
  /** 0 none, 1 small, 2 full — the crest grows with the creature. */
  readonly crest: 0 | 1 | 2
  readonly tail: boolean
  readonly fins: boolean
}

/** An unknown growth identifier draws the middle of the ladder, never nothing. */
const DEFAULT_BUILD: CreatureBuild = {
  scale: 0.86,
  bodyRadius: 0.62,
  headRadius: 0.42,
  hatched: true,
  crest: 1,
  tail: true,
  fins: false,
}

const BUILDS: Readonly<Record<string, CreatureBuild>> = {
  egg: {
    scale: 0.7,
    bodyRadius: 0.58,
    headRadius: 0,
    hatched: false,
    crest: 0,
    tail: false,
    fins: false,
  },
  hatchling: {
    scale: 0.72,
    bodyRadius: 0.5,
    headRadius: 0.38,
    hatched: true,
    crest: 0,
    tail: false,
    fins: false,
  },
  fledgling: DEFAULT_BUILD,
  companion: {
    scale: 0.96,
    bodyRadius: 0.68,
    headRadius: 0.44,
    hatched: true,
    crest: 2,
    tail: true,
    fins: false,
  },
  guardian: {
    scale: 1.06,
    bodyRadius: 0.74,
    headRadius: 0.46,
    hatched: true,
    crest: 2,
    tail: true,
    fins: true,
  },
}

interface MoodMotion {
  /** Vertical bob amplitude. */
  readonly bob: number
  readonly speed: number
  /** Resting tilt, radians. */
  readonly tilt: number
}

const DEFAULT_MOOD: MoodMotion = { bob: 0.05, speed: 1, tilt: 0 }

const MOOD_MOTION: Readonly<Record<string, MoodMotion>> = {
  joyful: { bob: 0.11, speed: 1.5, tilt: 0.05 },
  content: { bob: 0.05, speed: 1, tilt: 0 },
  curious: { bob: 0.07, speed: 1.25, tilt: 0.12 },
  lonely: { bob: 0.03, speed: 0.7, tilt: -0.08 },
  sleepy: { bob: 0.02, speed: 0.45, tilt: -0.14 },
  weary: { bob: 0.025, speed: 0.55, tilt: -0.11 },
  worried: { bob: 0.04, speed: 0.9, tilt: -0.05 },
}

/**
 * Where the creature stands in the 1080x1920 frame: the free band between the
 * top slot and the lower three, so nothing it does is hidden behind a card.
 */
const BASE_Y = 0.36

export interface PetProps {
  /** Growth ladder identifier from the snapshot (spec §6.3). */
  readonly growthStage?: string
  readonly emotionId?: string
  /** Command whose reaction is playing, from an active effect (spec §7.3(6)). */
  readonly reaction?: CommandName | null
  /** The creature is in a recoverable crisis: it rests (spec §6.3). */
  readonly resting?: boolean
}

export default function Pet({
  growthStage = '',
  emotionId = '',
  reaction = null,
  resting = false,
}: PetProps) {
  const group = useRef<THREE.Group>(null)
  const build = BUILDS[growthStage] ?? DEFAULT_BUILD
  const mood = resting
    ? (MOOD_MOTION['sleepy'] ?? DEFAULT_MOOD)
    : (MOOD_MOTION[emotionId] ?? DEFAULT_MOOD)

  /**
   * The creature keeps facing the room: it sways rather than spinning, so its
   * eyes are always readable — the screen has to be understood in five seconds
   * (spec §5.2), and a character turning its back is a second of that gone. Only
   * the play reaction turns all the way around.
   */
  useFrame((state, delta) => {
    const current = group.current
    if (current === null) return
    const time = state.clock.elapsedTime

    if (reaction === 'FEED') {
      current.position.y = BASE_Y + Math.abs(Math.sin(time * 9)) * 0.12
      current.rotation.z = Math.sin(time * 18) * 0.05
      current.rotation.y = Math.sin(time * 3) * 0.12
      return
    }
    if (reaction === 'PLAY') {
      current.position.y = BASE_Y + Math.abs(Math.sin(time * 4.5)) * 0.35
      current.rotation.z = Math.sin(time * 4.5) * 0.14
      current.rotation.y += delta * 2.2
      return
    }
    if (reaction === 'PET') {
      current.position.y = BASE_Y + Math.sin(time * 2) * 0.04
      current.rotation.z = THREE.MathUtils.lerp(current.rotation.z, 0.2, 0.06)
      current.rotation.y = Math.sin(time * 1.2) * 0.1
      return
    }

    current.position.y = BASE_Y + Math.sin(time * mood.speed) * mood.bob
    current.rotation.z = THREE.MathUtils.lerp(current.rotation.z, mood.tilt, 0.05)
    current.rotation.y = Math.sin(time * 0.4 * mood.speed) * 0.22
  })

  const eyeScale: [number, number, number] = resting ? [1, 0.18, 1] : [1, 1, 1]
  const headY = build.bodyRadius * 0.74 + build.headRadius * 0.42

  return (
    <group ref={group} scale={build.scale} position={[0, BASE_Y, 0]} dispose={null}>
      <mesh position={[0, 0, 0]} scale={build.hatched ? [1.08, 0.92, 1] : [1, 1.24, 1]}>
        <sphereGeometry args={[build.bodyRadius, 40, 28]} />
        <meshStandardMaterial
          color={build.hatched ? BODY_COLOR : SHELL_COLOR}
          roughness={0.62}
          metalness={0.04}
        />
      </mesh>

      {build.hatched ? null : (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <torusGeometry args={[build.bodyRadius * 0.98, 0.035, 12, 48]} />
          <meshStandardMaterial color={MARK_COLOR} roughness={0.5} />
        </mesh>
      )}

      {build.hatched ? (
        <>
          <mesh position={[0, headY, 0]}>
            <sphereGeometry args={[build.headRadius, 40, 28]} />
            <meshStandardMaterial color={BODY_COLOR} roughness={0.62} metalness={0.04} />
          </mesh>

          <mesh
            position={[-build.headRadius * 0.36, headY + 0.04, build.headRadius * 0.86]}
            scale={eyeScale}
          >
            <sphereGeometry args={[0.058, 20, 16]} />
            <meshStandardMaterial color={EYE_COLOR} roughness={0.3} />
          </mesh>
          <mesh
            position={[build.headRadius * 0.36, headY + 0.04, build.headRadius * 0.86]}
            scale={eyeScale}
          >
            <sphereGeometry args={[0.058, 20, 16]} />
            <meshStandardMaterial color={EYE_COLOR} roughness={0.3} />
          </mesh>

          <mesh
            position={[0, -build.bodyRadius * 0.16, build.bodyRadius * 0.86]}
            scale={[1, 0.78, 0.32]}
          >
            <sphereGeometry args={[build.bodyRadius * 0.5, 24, 18]} />
            <meshStandardMaterial color={MARK_COLOR} roughness={0.66} />
          </mesh>
        </>
      ) : null}

      {build.crest > 0 ? (
        <mesh position={[0, headY + build.headRadius * 0.88, -0.04]} rotation={[-0.3, 0, 0]}>
          <coneGeometry
            args={[
              build.headRadius * (build.crest === 2 ? 0.62 : 0.44),
              build.crest === 2 ? 0.56 : 0.36,
              5,
            ]}
          />
          <meshStandardMaterial color={MARK_COLOR} roughness={0.5} />
        </mesh>
      ) : null}

      {build.tail ? (
        <mesh
          position={[0, -build.bodyRadius * 0.32, -build.bodyRadius * 0.95]}
          rotation={[1.05, 0, 0]}
        >
          <coneGeometry args={[0.15, 0.5, 6]} />
          <meshStandardMaterial color={MARK_COLOR} roughness={0.5} />
        </mesh>
      ) : null}

      {build.fins ? (
        <>
          <mesh
            position={[-build.bodyRadius * 0.92, 0, 0]}
            rotation={[0, 0, -0.5]}
            scale={[0.5, 1, 0.25]}
          >
            <sphereGeometry args={[0.3, 20, 14]} />
            <meshStandardMaterial color={MARK_COLOR} roughness={0.5} />
          </mesh>
          <mesh
            position={[build.bodyRadius * 0.92, 0, 0]}
            rotation={[0, 0, 0.5]}
            scale={[0.5, 1, 0.25]}
          >
            <sphereGeometry args={[0.3, 20, 14]} />
            <meshStandardMaterial color={MARK_COLOR} roughness={0.5} />
          </mesh>
        </>
      ) : null}
    </group>
  )
}
