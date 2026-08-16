import React, { useEffect, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import usePetStore from '../store'

export default function Pet(props) {
  const group = useRef()
  const { scene } = useGLTF('/pet.glb')
  const { isEating, hunger, happiness, cleanliness, life, isDead, currentAction } = usePetStore()

  useEffect(() => {
    scene.traverse((child) => {
      if (!child.isMesh) return

      if (isDead) {
        child.material.color.setHex(0x4b5563)
      } else if (life <= 35 || hunger <= 25) {
        child.material.color.setHex(0xb8c0c7)
      } else if (happiness >= 90 || cleanliness >= 95) {
        child.material.color.setHex(0xfff08a)
      } else {
        child.material.color.setHex(0xffd84d)
      }
    })
  }, [cleanliness, happiness, hunger, isDead, life, scene])

  useFrame((state, delta) => {
    if (!group.current) return

    if (isDead) {
      group.current.rotation.z = THREE.MathUtils.lerp(group.current.rotation.z, Math.PI / 2, 0.1)
      group.current.position.y = THREE.MathUtils.lerp(group.current.position.y, -1.45, 0.08)
      return
    }

    group.current.rotation.z = THREE.MathUtils.lerp(group.current.rotation.z, 0, 0.1)

    if (currentAction === 'BigGift' || currentAction === 'Revive') {
      const wave = Math.sin(state.clock.elapsedTime * 18)
      const scale = 1.08 + wave * 0.1
      group.current.position.y = Math.sin(state.clock.elapsedTime * 10) * 0.28 - 0.15
      group.current.rotation.y += delta * 4.2
      group.current.scale.lerp(new THREE.Vector3(scale, scale, scale), 0.25)
      return
    }

    if (currentAction === 'Dance') {
      group.current.position.x = Math.sin(state.clock.elapsedTime * 8) * 0.3
      group.current.position.y = Math.sin(state.clock.elapsedTime * 16) * 0.18 - 0.25
      group.current.rotation.y += delta * 3.2
      group.current.scale.lerp(new THREE.Vector3(0.92, 0.92, 0.92), 0.18)
      return
    }

    if (currentAction === 'Wave') {
      group.current.rotation.z = Math.sin(state.clock.elapsedTime * 12) * 0.14
      group.current.position.y = THREE.MathUtils.lerp(group.current.position.y, -0.35, 0.12)
      group.current.rotation.y += delta * 1.4
      return
    }

    if (isEating) {
      group.current.position.y = Math.sin(state.clock.elapsedTime * 15) * 0.34 - 0.16
      const scale = 0.95 + Math.sin(state.clock.elapsedTime * 20) * 0.08
      group.current.scale.set(scale, scale, scale)
      group.current.rotation.y += delta * 3.0
      return
    }

    group.current.position.x = THREE.MathUtils.lerp(group.current.position.x, 0, 0.12)
    group.current.position.y = THREE.MathUtils.lerp(group.current.position.y, -0.38, 0.1)
    group.current.scale.lerp(new THREE.Vector3(0.82, 0.82, 0.82), 0.1)

    let rotationSpeed = 0.5
    if (hunger <= 30 || life <= 40) rotationSpeed = 0.1

    group.current.rotation.y += delta * rotationSpeed
  })

  return (
    <group ref={group} {...props} dispose={null}>
      <primitive object={scene} scale={0.78} position={[0, -0.35, 0]} />
    </group>
  )
}

useGLTF.preload('/pet.glb')
