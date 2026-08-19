import { describe, expect, it, afterEach } from 'vitest'

import { createTempStore } from '../../db/testing/temp-store.js'
import {
  commandEnvelope,
  createEngineHarness,
  TEST_EPOCH_MS,
} from '../../engine/testing/harness.js'
import { ConsentDirectory } from '../../identity/directory.js'
import {
  CommandMetrics,
  createCommandParserPort,
  loadInputConfig,
  parserLimits,
} from '../../input/index.js'
import { loadRetentionConfig } from '../../privacy/config.js'
import { silentLogger } from '../../secrets/redaction.js'
import { testChatConfig } from '../../testing/chat-test-support.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { ChatIngestSink } from './sink.js'
import { chatRuntimeDeps, type ChatWiring } from './wiring.js'

/**
 * The wiring `main.ts` hands to `createChatSource`, driven end to end.
 *
 * Review round 2 (B1): every consent test built its own inbox, so all of them
 * passed while the production wiring adapted the engine with a two-parameter
 * arrow and dropped the `hooks` argument the sink puts `onInserted` in. With the
 * gate open in production that meant `JOIN` stored nothing, `LEAVE` deleted
 * nothing, and the batch committed as though both had happened.
 *
 * These tests use the object `chatRuntimeDeps` returns — `main.ts` passes that
 * same object and nothing else — with a real store, a real `StateEngine` and a
 * real `ConsentDirectory`. Every identifier is obviously synthetic (spec §2.6).
 */

const BROADCAST_ID = 'brd_test_wiring'
const LIVE_CHAT_ID = 'chat_test_wiring'
const VIEWER = 'UC_TEST_synthetic_viewer_wiring'
const VIEWER_NAME = 'synthetic-viewer-wiring'

interface Wired {
  readonly deps: ReturnType<typeof chatRuntimeDeps>
  readonly harness: ReturnType<typeof createEngineHarness>
  readonly directory: ConsentDirectory | null
  dispose(): void
}

let wired: Wired | undefined

afterEach(() => {
  wired?.dispose()
  wired = undefined
})

function wire(identityGateOpen: boolean): Wired {
  const clock = new FakeClock({ epochMs: TEST_EPOCH_MS })
  const temp = createTempStore({ clock })
  const directory = identityGateOpen
    ? new ConsentDirectory({
        store: temp.store,
        clock,
        retention: loadRetentionConfig(),
        logger: silentLogger,
      })
    : null
  const harness = createEngineHarness({
    temp,
    clock,
    ...(directory === null ? {} : { identity: directory }),
  })
  const wiring: ChatWiring = {
    store: temp.store,
    engine: harness.engine,
    clock,
    inputConfig: loadInputConfig({ env: {} }),
    commandMetrics: new CommandMetrics({ consentGateOpen: identityGateOpen }),
    identityGateOpen,
    consent: directory,
    config: testChatConfig({ enabled: true }),
    logger: silentLogger,
    auth: null,
    resolveTarget: null,
  }
  harness.engine.start()
  return {
    deps: chatRuntimeDeps(wiring),
    harness,
    directory,
    dispose: () => {
      harness.dispose()
      temp.dispose()
    },
  }
}

/** One `LiveChatMessage` as the gRPC transport delivers it ([S4] proto). */
function chatItem(messageId: string, text: string): unknown {
  return {
    id: messageId,
    snippet: {
      type: 'TEXT_MESSAGE_EVENT',
      live_chat_id: LIVE_CHAT_ID,
      published_at: '2026-08-16T00:00:00.000Z',
      text_message_details: { message_text: text },
    },
    author_details: {
      channel_id: VIEWER,
      display_name: VIEWER_NAME,
      profile_image_url: 'https://example.invalid/avatar_test.png',
    },
  }
}

/** The sink `createChatSource` builds, given the deps `main.ts` passes. */
function sinkFor(active: Wired): ChatIngestSink {
  const { deps } = active
  return new ChatIngestSink({
    inbox: deps.inbox,
    clock: deps.clock,
    parseCommand: createCommandParserPort({
      context: () => ({ identityGateOpen: deps.identityGateOpen, voteWindowOpen: false }),
      limits: parserLimits(deps.inputConfig),
    }),
    sourceKey: `youtube:${LIVE_CHAT_ID}`,
    liveChatId: LIVE_CHAT_ID,
    broadcastId: BROADCAST_ID,
    ...(deps.consent === undefined ? {} : { consent: deps.consent }),
  })
}

describe('chatRuntimeDeps', () => {
  it('runs JOIN and LEAVE through the inbox the process actually passes', () => {
    const active = wire(true)
    wired = active
    const sink = sinkFor(active)

    sink.commit({
      sourceShape: 'grpc',
      items: [chatItem('msg_test_wiring_join', 'なのる')],
      nextPageToken: 'token_test_join',
    })
    const stored = active.harness.store.findConsentByChannelId(VIEWER)
    expect(stored?.displayName).toBe(VIEWER_NAME)

    active.harness.clock.advance(60_000)
    sink.commit({
      sourceShape: 'grpc',
      items: [chatItem('msg_test_wiring_leave', 'なまえけす')],
      nextPageToken: 'token_test_leave',
    })
    expect(active.harness.store.findConsentByChannelId(VIEWER)).toBeNull()
  })

  it('forwards the commit hooks the sink puts its consent decision in', () => {
    // The reviewer's probe, kept as the narrow regression guard: the defect was
    // an inbox adapter that accepted three arguments and passed two, so the hook
    // was never called while the envelope and the checkpoint committed anyway.
    const active = wire(true)
    wired = active
    const inserted: number[] = []

    const result = active.deps.inbox.ingest(
      [
        commandEnvelope({
          messageId: 'msg_test_wiring_hook',
          receivedAt: '2026-08-16T00:00:00.000Z',
          command: 'FEED',
        }),
      ],
      {
        sourceKey: 'simulator:chat_test_engine',
        liveChatId: 'chat_test_engine',
        nextPageToken: 'token_hook',
      },
      { onInserted: (_envelope, index) => inserted.push(index) },
    )

    expect(result.insertedCount).toBe(1)
    expect(inserted).toEqual([0])
  })

  it('passes no consent observer while the gate is closed', () => {
    const active = wire(false)
    wired = active

    expect(active.directory).toBeNull()
    expect(active.deps.consent).toBeUndefined()
    expect(active.deps.onConsentFailure).toBeUndefined()
    expect(active.deps.identityGateOpen).toBe(false)
  })
})
