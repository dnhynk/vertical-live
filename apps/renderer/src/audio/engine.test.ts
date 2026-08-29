import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SceneConditions } from '../visual/palette'
import { AmbientAudio } from './engine'
import { scoreFor } from './score'

/**
 * jsdom has no Web Audio, which is the point of the first test: the renderer
 * runs there, and a screen that threw because a browser had no `AudioContext`
 * would fail spec §5.2's own premise — the picture is the product and the sound
 * is optional.
 */

function conditions(overrides: Partial<SceneConditions> = {}): SceneConditions {
  return {
    worldPhaseId: 'day',
    environmentId: 'meadow',
    weatherId: 'clear',
    chapterId: 'gathering',
    emotionId: 'content',
    resting: false,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AmbientAudio without Web Audio', () => {
  it('reports itself unsupported and does nothing, rather than throwing', async () => {
    const audio = new AmbientAudio()
    expect(audio.state).toBe('unsupported')
    expect(() => audio.apply(scoreFor(conditions()))).not.toThrow()
    await expect(audio.resume()).resolves.toBe('unsupported')
    expect(() => audio.stop()).not.toThrow()
  })

  it('still remembers the score it was given, so a caller can skip repeats', () => {
    const audio = new AmbientAudio()
    audio.apply(scoreFor(conditions()))
    expect(audio.scoreId).toBe(scoreFor(conditions()).scoreId)
  })
})

describe('AmbientAudio with a context that refuses to construct', () => {
  it('degrades to silence instead of propagating the failure', () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('no output device')
        }
      },
    )
    const audio = new AmbientAudio()
    expect(() => audio.apply(scoreFor(conditions()))).not.toThrow()
    expect(audio.state).toBe('unsupported')
  })
})

describe('AmbientAudio lifecycle', () => {
  it('stops for good: a stopped instance ignores further scores', () => {
    const audio = new AmbientAudio()
    audio.stop()
    expect(audio.state).toBe('stopped')
    audio.apply(scoreFor(conditions({ worldPhaseId: 'night' })))
    // The score is not taken on after a stop, so nothing can restart the graph.
    expect(audio.scoreId).toBeNull()
    expect(audio.state).toBe('stopped')
  })
})
