import { useEffect, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Idle-pose constants. Everything here is purely visual — the renderer owns no
 * state (spec §10.2), so this component reads props only, never a store.
 */
const IDLE_COLOR = 0xffd84d
const IDLE_SCALE = 0.82
const IDLE_POSITION_Y = -0.38
const IDLE_SPIN_SPEED = 0.5

export default function Pet({ isEating = false, ...props }) {
  const group = useRef()
  const { scene } = useGLTF('/pet.glb')

  useEffect(() => {
    scene.traverse((child) => {
      if (child.isMesh) {
        child.material.color.setHex(IDLE_COLOR)
      }
    })
  }, [scene])

  useFrame((state, delta) => {
    if (!group.current) return

    if (isEating) {
      group.current.position.y = Math.sin(state.clock.elapsedTime * 15) * 0.34 - 0.16
      const scale = 0.95 + Math.sin(state.clock.elapsedTime * 20) * 0.08
      group.current.scale.set(scale, scale, scale)
      group.current.rotation.y += delta * 3.0
      return
    }

    group.current.rotation.z = THREE.MathUtils.lerp(group.current.rotation.z, 0, 0.1)
    group.current.position.x = THREE.MathUtils.lerp(group.current.position.x, 0, 0.12)
    group.current.position.y = THREE.MathUtils.lerp(group.current.position.y, IDLE_POSITION_Y, 0.1)
    group.current.scale.lerp(new THREE.Vector3(IDLE_SCALE, IDLE_SCALE, IDLE_SCALE), 0.1)
    group.current.rotation.y += delta * IDLE_SPIN_SPEED
  })

  return (
    <group ref={group} {...props} dispose={null}>
      <primitive object={scene} scale={0.78} position={[0, -0.35, 0]} />
    </group>
  )
}

useGLTF.preload('/pet.glb')
