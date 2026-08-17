import { useEffect, useRef } from 'react'
import { shaderMaterial } from '@react-three/drei'
import { extend, useFrame, type ThreeElement } from '@react-three/fiber'
import * as THREE from 'three'

import type { ScenePalette } from '../visual/palette'

/**
 * The sky behind the creature: a vertical gradient that the world's time of day,
 * place and weather move (spec §12.5 — the same command must not always produce
 * the same picture).
 *
 * The three colours and the drift speed come from the palette, which is a pure
 * function of the snapshot, so the background is a read model like everything
 * else. The shader itself is written here; `ASSETS.md` records it as original.
 */
const DynamicBackgroundMaterial = shaderMaterial(
  {
    uTime: 0,
    uSkyTop: new THREE.Color('#1b2a3a'),
    uSkyMid: new THREE.Color('#2f4258'),
    uSkyBottom: new THREE.Color('#0f1720'),
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
    uniform vec3 uSkyTop;
    uniform vec3 uSkyMid;
    uniform vec3 uSkyBottom;
    varying vec2 vUv;
    void main() {
      float y = clamp(vUv.y, 0.0, 1.0);
      vec3 base = y < 0.5
        ? mix(uSkyBottom, uSkyMid, y * 2.0)
        : mix(uSkyMid, uSkyTop, (y - 0.5) * 2.0);
      float drift = sin(vUv.x * 3.1 + uTime) * 0.5 + 0.5;
      float band = smoothstep(0.2, 0.9, drift) * 0.05;
      float glow = smoothstep(1.05, 0.2, distance(vUv, vec2(0.5, 0.42)));
      gl_FragColor = vec4(base * (0.86 + 0.16 * glow) + band, 1.0);
    }
  `,
)

extend({ DynamicBackgroundMaterial })

declare module '@react-three/fiber' {
  interface ThreeElements {
    dynamicBackgroundMaterial: ThreeElement<typeof DynamicBackgroundMaterial>
  }
}

type BackgroundMaterial = THREE.ShaderMaterial & {
  uTime: number
  uSkyTop: THREE.Color
  uSkyMid: THREE.Color
  uSkyBottom: THREE.Color
}

export interface BackgroundProps {
  palette: ScenePalette
}

export default function Background({ palette }: BackgroundProps) {
  const materialRef = useRef<BackgroundMaterial>(null)

  useEffect(() => {
    const material = materialRef.current
    if (material === null) return
    material.uSkyTop.set(palette.skyTop)
    material.uSkyMid.set(palette.skyMid)
    material.uSkyBottom.set(palette.skyBottom)
  }, [palette])

  useFrame((_state, delta) => {
    if (materialRef.current !== null) {
      materialRef.current.uTime += delta * 0.5 * palette.motion
    }
  })

  return (
    // Sized to the camera frustum at this depth (9:16 at fov 75, camera z=5), so
    // the whole gradient is on screen. A plane much larger than the view would
    // show only a slice of it and read as a flat colour.
    <mesh scale={[9.5, 16.2, 1]} position={[0, 0, -5]}>
      <planeGeometry args={[1, 1]} />
      <dynamicBackgroundMaterial ref={materialRef} />
    </mesh>
  )
}
