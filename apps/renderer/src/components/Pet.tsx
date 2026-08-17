import { useEffect, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import { useFrame, type ThreeElements } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Idle-pose constants. Everything here is purely visual — the renderer owns no
 * state (spec §10.2), so this component reads props only, never a store.
 *
 * `public/pet.glb` is a development placeholder, not a release asset
 * (BOARD A-10, spec §16).
 */
const IDLE_COLOR = 0xffd84d
const IDLE_SCALE = 0.82
const IDLE_POSITION_Y = -0.38
const IDLE_SPIN_SPEED = 0.5

export type PetProps = ThreeElements['group'] & {
  /** Driven by an active ACTION_REACTION effect, never by local game logic. */
  isEating?: boolean
}

export default function Pet({ isEating = false, ...props }: PetProps) {
  const group = useRef<THREE.Group>(null)
  const { scene } = useGLTF('/pet.glb')

  useEffect(() => {
    scene.traverse((child: THREE.Object3D) => {
      if (!(child instanceof THREE.Mesh)) return
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      for (const material of materials) {
        const color = (material as { color?: THREE.Color }).color
        if (color instanceof THREE.Color) color.setHex(IDLE_COLOR)
      }
    })
  }, [scene])

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
      <primitive object={scene} scale={0.78} position={[0, -0.35, 0]} />
    </group>
  )
}

useGLTF.preload('/pet.glb')
