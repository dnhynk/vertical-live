import { useRef } from 'react'
import { useFrame, type ThreeElements } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Placeholder creature built from primitives in code.
 *
 * It is deliberately generic — a rounded body, a head and two eyes, with no
 * silhouette, marking or feature borrowed from anything: CLAUDE.md §3 and spec
 * §12.1 forbid third-party characters and assets of unclear rights, and the
 * prototype's `pet.glb` was found to be exactly that (2026-08-17, ticket
 * "Questions asked"). It now sits in `legacy/renderer-prototype/`, off the
 * product path, and `ASSETS.md` records both. The original creature design is
 * T14.
 *
 * Everything here is visual: the renderer owns no state (spec §10.2) and this
 * component reads props only, never a store. `isEating` is driven by an active
 * ACTION_REACTION effect from the server.
 */
const IDLE_COLOR = 0xffd84d
const EYE_COLOR = 0x2b2118
const IDLE_SCALE = 0.82
const IDLE_POSITION_Y = -1.15
const IDLE_SPIN_SPEED = 0.5

export type PetProps = ThreeElements['group'] & {
  /** Driven by an active ACTION_REACTION effect, never by local game logic. */
  isEating?: boolean
}

export default function Pet({ isEating = false, ...props }: PetProps) {
  const group = useRef<THREE.Group>(null)

  useFrame((state, delta) => {
    const current = group.current
    if (current === null) return

    if (isEating) {
      current.position.y = Math.sin(state.clock.elapsedTime * 15) * 0.34 - 0.16
      const scale = 0.95 + Math.sin(state.clock.elapsedTime * 20) * 0.08
      current.scale.set(scale, scale, scale)
      current.rotation.y += delta * 3.0
      return
    }

    current.rotation.z = THREE.MathUtils.lerp(current.rotation.z, 0, 0.1)
    current.position.x = THREE.MathUtils.lerp(current.position.x, 0, 0.12)
    current.position.y = THREE.MathUtils.lerp(current.position.y, IDLE_POSITION_Y, 0.1)
    current.scale.lerp(new THREE.Vector3(IDLE_SCALE, IDLE_SCALE, IDLE_SCALE), 0.1)
    current.rotation.y += delta * IDLE_SPIN_SPEED
  })

  return (
    <group ref={group} {...props} dispose={null}>
      <mesh position={[0, -0.15, 0]} scale={[1, 0.86, 1]}>
        <sphereGeometry args={[0.62, 32, 24]} />
        <meshStandardMaterial color={IDLE_COLOR} roughness={0.55} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.5, 0]}>
        <sphereGeometry args={[0.42, 32, 24]} />
        <meshStandardMaterial color={IDLE_COLOR} roughness={0.55} metalness={0.05} />
      </mesh>
      <mesh position={[-0.16, 0.56, 0.36]}>
        <sphereGeometry args={[0.06, 16, 12]} />
        <meshStandardMaterial color={EYE_COLOR} roughness={0.35} />
      </mesh>
      <mesh position={[0.16, 0.56, 0.36]}>
        <sphereGeometry args={[0.06, 16, 12]} />
        <meshStandardMaterial color={EYE_COLOR} roughness={0.35} />
      </mesh>
    </group>
  )
}
