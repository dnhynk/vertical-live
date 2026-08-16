import React, { useRef } from 'react'
import { extend, useFrame } from '@react-three/fiber'
import { shaderMaterial } from '@react-three/drei'
import * as THREE from 'three'

const DynamicBackgroundMaterial = shaderMaterial(
  {
    uTime: 0,
    uColorStart: new THREE.Color('#0f766e'),
    uColorMid: new THREE.Color('#f97316'),
    uColorEnd: new THREE.Color('#312e81'),
  },
  `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  `
    uniform float uTime;
    uniform vec3 uColorStart;
    uniform vec3 uColorMid;
    uniform vec3 uColorEnd;
    varying vec2 vUv;
    void main() {
      float wave = sin(vUv.x * 10.0 + uTime) * 0.5 + 0.5;
      float wave2 = cos(vUv.y * 5.0 + uTime * 0.5) * 0.5 + 0.5;
      vec3 lowMix = mix(uColorStart, uColorMid, wave);
      vec3 highMix = mix(uColorMid, uColorEnd, wave2);
      vec3 color = mix(lowMix, highMix, wave * wave2);
      gl_FragColor = vec4(color, 1.0);
    }
  `,
)

extend({ DynamicBackgroundMaterial })

export default function Background() {
  const materialRef = useRef()

  useFrame((state, delta) => {
    if (materialRef.current) {
      materialRef.current.uTime += delta * 0.5
    }
  })

  return (
    <mesh scale={[100, 100, 1]} position={[0, 0, -5]}>
      <planeGeometry args={[1, 1]} />
      <dynamicBackgroundMaterial ref={materialRef} />
    </mesh>
  )
}
