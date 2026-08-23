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

const BODY_COLOR = '#f6e3bc'
const MARK_COLOR = '#5fa791'
const EYE_COLOR = '#241c15'
const SHELL_COLOR = '#ece6d8'
/** Warm underside, so the body reads as a volume rather than a flat sphere. */
const BELLY_COLOR = '#fbf1da'
const BLUSH_COLOR = '#e79a86'
const HIGHLIGHT_COLOR = '#ffffff'

/**
 * The plush surface. `sheen` is what separates a soft creature from a plastic
 * ball under the same light: it adds a fabric-like falloff at grazing angles,
 * which is most of what makes the silhouette read at phone size (§14.2(1)).
 */
function bodyMaterial(color: string) {
  return (
    <meshPhysicalMaterial
      color={color}
      roughness={0.78}
      metalness={0}
      sheen={0.6}
      sheenColor={'#ffd9a8'}
      sheenRoughness={0.5}
      clearcoat={0.08}
      clearcoatRoughness={0.7}
    />
  )
}

interface CreatureBuild {
  readonly scale: number
  readonly bodyRadius: number
  readonly headRadius: number
  readonly hatched: boolean
  /** 0 none, 1 small, 2 full — the crest grows with the creature. */
  readonly crest: 0 | 1 | 2
  readonly tail: boolean
  readonly fins: boolean
  /** Ears appear once the creature can look around (spec §6.3: parts are gained). */
  readonly ears: boolean
  /** A fragment of shell still on the head: only the stage right after hatching. */
  readonly shellCap: boolean
}

/** An unknown growth identifier draws the middle of the ladder, never nothing. */
const DEFAULT_BUILD: CreatureBuild = {
  scale: 1.0,
  bodyRadius: 0.62,
  headRadius: 0.52,
  hatched: true,
  crest: 1,
  tail: true,
  fins: false,
  ears: true,
  shellCap: false,
}

const BUILDS: Readonly<Record<string, CreatureBuild>> = {
  egg: {
    scale: 0.82,
    bodyRadius: 0.58,
    headRadius: 0,
    hatched: false,
    crest: 0,
    tail: false,
    fins: false,
    ears: false,
    shellCap: false,
  },
  hatchling: {
    scale: 0.84,
    bodyRadius: 0.5,
    headRadius: 0.56,
    hatched: true,
    crest: 0,
    tail: false,
    fins: false,
    ears: false,
    shellCap: true,
  },
  fledgling: DEFAULT_BUILD,
  companion: {
    scale: 1.12,
    bodyRadius: 0.68,
    headRadius: 0.54,
    hatched: true,
    crest: 2,
    tail: true,
    fins: false,
    ears: true,
    shellCap: false,
  },
  guardian: {
    scale: 1.24,
    bodyRadius: 0.74,
    headRadius: 0.46,
    hatched: true,
    crest: 2,
    tail: true,
    fins: true,
    ears: true,
    shellCap: false,
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
 * Measured against a host screenshot — at the old height the lower body sat
 * behind the `LAST ACTION` card and the silhouette lost its feet.
 */
const BASE_Y = 0.92

/** Left and right, so paired parts are written once. */
const EYE_SIDES = [-1, 1] as const

/** Unit-sphere offsets for the egg speckles: fixed, so the egg never flickers. */
const EGG_SPECKLES: readonly (readonly [number, number, number, number])[] = [
  [-0.42, 0.34, 0.82, 0.05],
  [0.5, -0.12, 0.78, 0.042],
  [-0.16, -0.46, 0.84, 0.036],
  [0.26, 0.58, 0.72, 0.032],
]

/** Shell shards: spin around the head, lean, and size against the head radius. */
const SHELL_SHARDS: readonly (readonly [number, number, number])[] = [
  [0.4, 0.3, 0.92],
  [3.5, -0.24, 0.78],
]

/** Petal lateral offset and lean; the third only grows in at `crest: 2`. */
const CREST_PETALS: readonly (readonly [number, number])[] = [
  [-0.62, -0.34],
  [0.62, 0.34],
  [0, 0],
]

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
      {/* Body. Slightly wider than tall once hatched, so it sits rather than floats. */}
      <mesh position={[0, 0, 0]} scale={build.hatched ? [1.08, 0.94, 1.02] : [1, 1.26, 1]}>
        <sphereGeometry args={[build.bodyRadius, 48, 32]} />
        {bodyMaterial(build.hatched ? BODY_COLOR : SHELL_COLOR)}
      </mesh>

      {build.hatched ? null : (
        <>
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <torusGeometry args={[build.bodyRadius * 0.98, 0.038, 16, 64]} />
            <meshStandardMaterial color={MARK_COLOR} roughness={0.5} />
          </mesh>
          {/* Speckles: an unhatched egg is still a character, not a blank ovoid. */}
          {EGG_SPECKLES.map(([x, y, z, r], index) => (
            <mesh
              key={index}
              position={[x * build.bodyRadius, y * build.bodyRadius, z * build.bodyRadius]}
            >
              <sphereGeometry args={[r, 12, 10]} />
              <meshStandardMaterial color={MARK_COLOR} roughness={0.7} />
            </mesh>
          ))}
        </>
      )}

      {build.hatched ? (
        <>
          {/* Head */}
          <mesh position={[0, headY, 0]} scale={[1.02, 1, 1]}>
            <sphereGeometry args={[build.headRadius, 48, 32]} />
            {bodyMaterial(BODY_COLOR)}
          </mesh>

          {/* Muzzle: a little forward volume so the face has structure in profile. */}
          <mesh
            position={[0, headY - build.headRadius * 0.18, build.headRadius * 0.74]}
            scale={[1, 0.72, 0.7]}
          >
            <sphereGeometry args={[build.headRadius * 0.42, 24, 18]} />
            {bodyMaterial(BELLY_COLOR)}
          </mesh>

          {EYE_SIDES.map((side) => (
            <group key={side}>
              <mesh
                position={[
                  side * build.headRadius * 0.38,
                  headY + build.headRadius * 0.1,
                  build.headRadius * 0.84,
                ]}
                scale={eyeScale}
              >
                <sphereGeometry args={[build.headRadius * 0.17, 24, 18]} />
                <meshStandardMaterial color={EYE_COLOR} roughness={0.18} metalness={0.02} />
              </mesh>
              {/* The catchlight. One small sphere is most of what reads as "alive". */}
              {resting ? null : (
                <mesh
                  position={[
                    side * build.headRadius * 0.38 + build.headRadius * 0.06,
                    headY + build.headRadius * 0.16,
                    build.headRadius * 0.96,
                  ]}
                >
                  <sphereGeometry args={[build.headRadius * 0.055, 12, 10]} />
                  <meshBasicMaterial color={HIGHLIGHT_COLOR} />
                </mesh>
              )}
              {/* Cheek */}
              <mesh
                position={[
                  side * build.headRadius * 0.66,
                  headY - build.headRadius * 0.2,
                  build.headRadius * 0.66,
                ]}
                scale={[1, 0.62, 0.4]}
              >
                <sphereGeometry args={[build.headRadius * 0.2, 20, 14]} />
                <meshStandardMaterial
                  color={BLUSH_COLOR}
                  roughness={0.85}
                  transparent
                  opacity={0.55}
                />
              </mesh>
            </group>
          ))}

          {build.ears
            ? EYE_SIDES.map((side) => (
                <mesh
                  key={`ear${side}`}
                  position={[
                    side * build.headRadius * 0.72,
                    headY + build.headRadius * 0.66,
                    -build.headRadius * 0.08,
                  ]}
                  rotation={[0, 0, side * 0.42]}
                  scale={[0.52, 1, 0.44]}
                >
                  <sphereGeometry args={[build.headRadius * 0.36, 20, 16]} />
                  {bodyMaterial(BODY_COLOR)}
                </mesh>
              ))
            : null}

          {/*
            What is left of the egg, right after hatching. Two shards, not a cap:
            a full dome read as a helmet on the host screenshot — a grey plate
            across the head that looked like the head had been cut off. A piece
            that covers part of the circumference and sits at an angle reads as
            broken, which is the whole point of the stage.
          */}
          {build.shellCap
            ? SHELL_SHARDS.map(([spin, lean, size], index) => (
                <mesh
                  key={index}
                  position={[0, headY + build.headRadius * 0.52, 0]}
                  rotation={[lean, spin, 0.34]}
                >
                  <sphereGeometry
                    args={[build.headRadius * size, 20, 12, 0, Math.PI * 0.72, 0, Math.PI * 0.34]}
                  />
                  <meshStandardMaterial
                    color={SHELL_COLOR}
                    roughness={0.62}
                    side={THREE.DoubleSide}
                  />
                </mesh>
              ))
            : null}

          {/* Belly mark */}
          <mesh
            position={[0, -build.bodyRadius * 0.18, build.bodyRadius * 0.84]}
            scale={[1, 0.7, 0.26]}
          >
            <sphereGeometry args={[build.bodyRadius * 0.42, 28, 20]} />
            <meshStandardMaterial color={BELLY_COLOR} roughness={0.85} transparent opacity={0.75} />
          </mesh>
        </>
      ) : null}

      {/* Crest: rounded petals rather than a cone, so it reads as soft. */}
      {build.crest > 0
        ? CREST_PETALS.slice(0, build.crest === 2 ? 3 : 2).map(([offset, lean], index) => (
            <mesh
              key={index}
              position={[
                offset * build.headRadius * 0.5,
                headY + build.headRadius * (build.crest === 2 ? 0.92 : 0.82),
                -build.headRadius * 0.14,
              ]}
              rotation={[-0.34, 0, lean]}
              scale={[0.42, 1, 0.42]}
            >
              <sphereGeometry
                args={[build.headRadius * (build.crest === 2 ? 0.46 : 0.34), 20, 16]}
              />
              <meshStandardMaterial color={MARK_COLOR} roughness={0.6} />
            </mesh>
          ))
        : null}

      {build.tail ? (
        <mesh
          position={[0, -build.bodyRadius * 0.3, -build.bodyRadius * 0.98]}
          rotation={[1.0, 0, 0]}
          scale={[0.6, 1, 0.6]}
        >
          <capsuleGeometry args={[0.14, 0.34, 8, 20]} />
          <meshStandardMaterial color={MARK_COLOR} roughness={0.6} />
        </mesh>
      ) : null}

      {build.fins
        ? EYE_SIDES.map((side) => (
            <mesh
              key={`fin${side}`}
              position={[side * build.bodyRadius * 0.94, 0.02, -0.04]}
              rotation={[0, 0, side * 0.55]}
              scale={[0.34, 1, 0.5]}
            >
              <sphereGeometry args={[build.bodyRadius * 0.5, 24, 18]} />
              <meshStandardMaterial color={MARK_COLOR} roughness={0.6} />
            </mesh>
          ))
        : null}
    </group>
  )
}
