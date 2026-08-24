import { afterEach, describe, expect, it } from 'vitest'

import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { loadQuotaConfig } from './config.js'
import { createProcessQuotaTracker } from './runtime.js'

describe('createProcessQuotaTracker', () => {
  let temp: TempStore | undefined

  afterEach(() => {
    temp?.dispose()
    temp = undefined
  })

  it('creates a store-backed tracker for chat-only production posture', () => {
    const clock = new FakeClock()
    temp = createTempStore({ clock })
    const tracker = createProcessQuotaTracker({
      chatEnabled: true,
      broadcastEnabled: false,
      clock,
      config: loadQuotaConfig(),
      store: temp.store,
    })

    expect(tracker).not.toBeNull()
    tracker?.record('liveChatMessages.streamList')
    expect(temp.store.readQuotaUsage(tracker?.snapshot().quotaDay ?? '')).toEqual(
      new Map([['liveChatMessages.streamList', 1]]),
    )
  })

  it('does not allocate a tracker when neither integration can spend quota', () => {
    const clock = new FakeClock()
    temp = createTempStore({ clock })

    expect(
      createProcessQuotaTracker({
        chatEnabled: false,
        broadcastEnabled: false,
        clock,
        config: loadQuotaConfig(),
        store: temp.store,
      }),
    ).toBeNull()
  })
})
