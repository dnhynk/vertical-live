import { useEffect, useRef } from 'react'
import { shaderMaterial } from '@react-three/drei'
import { extend, useFrame, type ThreeElement } from '@react-three/fiber'
import * as THREE from 'three'

import type { ScenePalette } from '../visual/palette'

/**
 * The room behind the creature: sky, a sun or moon, drifting cloud, two
 * parallax ridges and the ground it stands on — all drawn by one shader, so the
 * world's time of day, place and weather move the whole scene rather than only a
 * gradient (spec §12.5 — the same command must not always produce the same
 * picture).
 *
 * Every colour comes from the palette, which is a pure function of the snapshot,
 * so the background is a read model like everything else. Nothing is sampled
 * from a file: the ridges are sums of sines and the stars are a hash, which
 * keeps `ASSETS.md` honest (no third-party texture) and the frame budget flat —
 * one full-screen pass with no texture fetches.
 *
 * The layer order is the depth order, and each layer is separated from the one
 * behind it by value rather than by outline, because a 9:16 frame on a phone
 * loses thin edges before it loses contrast (spec §14.2(1)).
 */
const DynamicBackgroundMaterial = shaderMaterial(
  {
    uTime: 0,
    uSkyTop: new THREE.Color('#1b2a3a'),
    uSkyMid: new THREE.Color('#2f4258'),
    uSkyBottom: new THREE.Color('#0f1720'),
    uGlow: new THREE.Color('#c0a6ff'),
    uNight: 0,
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
    uniform float uNight;
    uniform vec3 uSkyTop;
    uniform vec3 uSkyMid;
    uniform vec3 uSkyBottom;
    uniform vec3 uGlow;
    varying vec2 vUv;

    // The frame is 9:16, so x is compressed against y. Ridges and clouds are
    // shaped in this space to keep their proportions on a phone.
    const float ASPECT = 0.5625;
    const float HORIZON = 0.55;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    // The frame is 9:16, so a circle in uv space draws as an ellipse on screen.
    // Everything round goes through here first.
    vec2 circular(vec2 delta) {
      return vec2(delta.x * ASPECT, delta.y);
    }

    // Three sines rather than noise: cheap, stable frame to frame, and a ridge
    // does not need to be irregular to read as a ridge.
    float ridge(float x, float seed, float amplitude) {
      return sin(x * 2.1 + seed) * amplitude
           + sin(x * 4.7 + seed * 1.7) * amplitude * 0.42
           + sin(x * 9.3 + seed * 2.3) * amplitude * 0.16;
    }

    void main() {
      float y = clamp(vUv.y, 0.0, 1.0);
      vec3 sky = y < 0.5
        ? mix(uSkyBottom, uSkyMid, y * 2.0)
        : mix(uSkyMid, uSkyTop, (y - 0.5) * 2.0);

      // Sun or moon: one soft source, high and slightly off centre so the frame
      // is not symmetrical. Its colour is the world's rim light.
      // Kept low and small: high and wide, its halo washes over the top HUD card
      // and reads as a smudge rather than a light source (measured on the host).
      vec2 celestial = vec2(0.72, 0.66);
      float d = length(circular(vUv - celestial));
      float disc = smoothstep(0.032, 0.022, d);
      float halo = smoothstep(0.2, 0.0, d);
      sky += uGlow * (halo * 0.10 + disc * 0.45);

      // Stars, night only. Quantised cells so they hold still.
      // A dot inside the cell, not the cell itself: filling the cell drew 32px
      // squares on the host screenshot.
      vec2 starUv = vec2(vUv.x * 34.0, vUv.y * 60.0);
      vec2 cell = floor(starUv);
      vec2 inCell = fract(starUv) - 0.5;
      float present = step(0.985, hash(cell));
      float dot = smoothstep(0.2, 0.02, length(inCell));
      float twinkle = 0.55 + 0.45 * sin(uTime * 2.0 + hash(cell + 3.0) * 6.28);
      sky += vec3(present * dot * twinkle * uNight * 0.85) * smoothstep(HORIZON, 1.0, vUv.y);

      // Cloud band in the upper half, drifting.
      float cx = vUv.x + uTime * 0.012;
      float cloud = sin(cx * 5.3) * 0.5 + sin(cx * 11.1 + 1.7) * 0.25 + sin(cx * 2.3 - 0.6) * 0.3;
      float cloudBand = smoothstep(0.1, 0.0, abs(vUv.y - (0.8 + cloud * 0.03)));
      sky = mix(sky, sky + uGlow * 0.10 + vec3(0.05), cloudBand * (0.35 - uNight * 0.15));

      // Two parallax ridges. The far one is closer to the sky colour, which is
      // what makes it read as distance rather than as a second near hill.
      float farY  = HORIZON + 0.105 + ridge((vUv.x + uTime * 0.004) / ASPECT, 0.0, 0.026);
      float nearY = HORIZON + 0.038 + ridge((vUv.x + uTime * 0.011) / ASPECT, 2.4, 0.044);

      // Each layer is a clear step darker than the one behind it. Equal-value
      // layers were the mistake in the first pass: they merged into one brown
      // mass on the host screenshot instead of reading as distance.
      vec3 farColor  = mix(sky * 0.82, uSkyBottom * 0.62, 0.55);
      vec3 nearColor = mix(uSkyBottom * 0.42, vec3(0.04, 0.05, 0.08), 0.35 + uNight * 0.25);

      vec3 color = sky;
      color = mix(color, farColor, smoothstep(farY + 0.004, farY - 0.004, vUv.y));
      color = mix(color, nearColor, smoothstep(nearY + 0.004, nearY - 0.004, vUv.y));

      // Ground. Slightly warmer than the near ridge so the creature has a floor
      // to stand on rather than a wall behind it.
      // The ground is lighter than the ridge in front of the creature, which is
      // what makes it a floor rather than another hill.
      float depth = smoothstep(HORIZON, 0.0, vUv.y);
      vec3 groundColor = mix(uSkyBottom * 0.9, uSkyBottom * 0.4, depth * 0.85) + vec3(0.012);
      float ground = smoothstep(HORIZON + 0.006, HORIZON - 0.006, vUv.y);
      color = mix(color, groundColor, ground);

      // A soft pool of light where the creature stands, so the eye goes there.
      float pool = smoothstep(0.2, 0.0, length(circular(vUv - vec2(0.5, HORIZON - 0.03))));
      color += uGlow * pool * ground * 0.22;

      // Vignette: 9:16 crops hard on phones, and the corners are where nothing
      // important ever is.
      float vignette = smoothstep(1.05, 0.32, distance(vUv, vec2(0.5, 0.5)));
      color *= mix(0.72, 1.0, vignette);

      gl_FragColor = vec4(color, 1.0);
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
  uGlow: THREE.Color
  uNight: number
}

/**
 * How dark the world is, read off the sky the palette already chose rather than
 * added to `ScenePalette`: stars and ridge contrast follow the same source as
 * every other colour, and no other module has to learn a new field.
 */
function nightness(skyTop: string): number {
  const color = new THREE.Color(skyTop)
  const luminance = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722
  return THREE.MathUtils.clamp(1 - luminance * 3.2, 0, 1)
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
    material.uGlow.set(palette.rimColor)
    material.uNight = nightness(palette.skyTop)
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
