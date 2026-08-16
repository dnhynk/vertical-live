import { describe, expect, it } from 'vitest'

import { CONTRACT_VERSION } from './index.js'

describe('CONTRACT_VERSION', () => {
  it('is 1', () => {
    expect(CONTRACT_VERSION).toBe(1)
  })
})
