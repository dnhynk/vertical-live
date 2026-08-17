import * as THREE from 'three'

/**
 * A soft contact shadow, drawn in code as a radial alpha gradient.
 *
 * Without it the creature floats over the gradient; with a hard-edged disc it
 * looks like a hole. This is geometry-free and asset-free — it is generated at
 * runtime, so there is nothing to license (spec §12.1) and nothing to load.
 */
export function createContactShadowTexture(size = 128): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (context === null) return new THREE.Texture()

  const half = size / 2
  const gradient = context.createRadialGradient(half, half, 0, half, half, half)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.5)')
  gradient.addColorStop(0.5, 'rgba(0, 0, 0, 0.22)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)

  return new THREE.CanvasTexture(canvas)
}
