import type { WorldSnapshot } from '@vl/contract'
import { describe, expect, it } from 'vitest'

import { loadInputConfig } from '../../input/config.js'
import { createTempStore } from '../../db/testing/temp-store.js'
import { storeInbox, testChatConfig } from '../../testing/chat-test-support.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { chatParserPort, createChatSource } from './runtime.js'

/**
 * The wiring `main.ts` uses. The important property is the negative one: with
 * `youtube.chat.enabled` false the process must not reach for a Google client
 * id or an OS vault at all, so a developer can run the world locally.
 */

const inputConfig = loadInputConfig()

function snapshotWith(mission: WorldSnapshot['mission']): WorldSnapshot {
  return { mission } as WorldSnapshot
}

describe('createChatSource', () => {
  it('returns null while the config switch is off, touching no credential', async () => {
    const temp = createTempStore({ clock: new FakeClock() })
    try {
      const source = await createChatSource({
        store: temp.store,
        inbox: storeInbox(temp.store),
        engine: { ready: true, snapshot: () => snapshotWith(null) },
        clock: temp.clock,
        inputConfig,
        identityGateOpen: false,
        config: testChatConfig({ enabled: false }),
      })

      expect(source).toBeNull()
    } finally {
      temp.dispose()
    }
  })
})

describe('chatParserPort', () => {
  const port = (mission: WorldSnapshot['mission'], identityGateOpen = false) =>
    chatParserPort({
      engine: { snapshot: () => snapshotWith(mission) },
      inputConfig,
      identityGateOpen,
    })

  const openWindow: WorldSnapshot['mission'] = {
    missionId: 'mission_test',
    progress: { current: 0, target: 6 },
    choices: [
      { choiceId: 'choice_a', labelKey: 'mission.choice.a', commandName: 'VOTE_A' },
      { choiceId: 'choice_b', labelKey: 'mission.choice.b', commandName: 'VOTE_B' },
    ],
    choiceClosesAt: '2026-08-17T00:10:00.000Z',
  }

  it('accepts a free command alias', () => {
    expect(port(null)('ごはん')).toEqual({ name: 'FEED', argument: null })
  })

  it('rejects a vote while no choice window is open (spec §7.1)', () => {
    expect(port(null, true)('A')).toBeNull()
    expect(
      port(
        {
          missionId: 'mission_test',
          progress: { current: 0, target: 6 },
          choices: [],
          choiceClosesAt: null,
        },
        true,
      )('A'),
    ).toBeNull()
  })

  it('accepts a vote only when the window and the identity gate are both open', () => {
    // BOARD A-1/A-9: with the gate closed there is no per-user attribution, so
    // branch voting is off even inside a window. The port reads both facts from
    // live state on every message rather than caching either.
    expect(port(openWindow, false)('A')).toBeNull()
    expect(port(openWindow, true)('A')).toEqual({ name: 'VOTE_A', argument: null })
  })
})
