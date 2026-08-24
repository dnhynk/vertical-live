import type { CommandParser } from '@vl/contract'
import { loadSourceFixture } from '@vl/contract/fixtures'

import type { PersistenceStore } from '../db/store.js'
import type { InboxWriter } from '../engine/ingest.js'
import type { ChatConfig } from '../youtube/chat/config.js'
import type { ChatAccessTokens } from '../youtube/chat/retry.js'

/**
 * Shared scaffolding for the chat source tests.
 *
 * Delays are microscopic on purpose: these tests drive a real gRPC server and a
 * real HTTP server over loopback, so they run on the system clock and shrink the
 * configured intervals instead of virtualizing time. The pure units that do need
 * a virtual clock (health signals, poll-interval clamping) take a `FakeClock`
 * directly.
 *
 * Every identifier is an obviously synthetic test value (spec §2.6).
 */

export const TEST_LIVE_CHAT_ID = 'chat_test_0001'
export const TEST_BROADCAST_ID = 'brd_test_0001'
export const TEST_SOURCE_KEY = `youtube:${TEST_LIVE_CHAT_ID}`
export const TEST_ACCESS_TOKEN = 'test-access-token'

/** The same shape `loadChatConfig` produces, with test-scale intervals. */
export function testChatConfig(overrides: Partial<ChatConfig> = {}): ChatConfig {
  return {
    enabled: true,
    // Closed by default (BOARD A-1); the consent-mode tests pass `true` and the
    // `authorDetails` part together, the way `loadChatConfig` derives them.
    identityGateOpen: false,
    liveChatId: TEST_LIVE_CHAT_ID,
    broadcastId: TEST_BROADCAST_ID,
    parts: ['id', 'snippet'],
    maxResults: 200,
    successfulStreamMinStartIntervalMs: 1,
    grpc: {
      endpoint: '127.0.0.1:1',
      keepalive: { timeMs: 300_000, timeoutMs: 20_000, permitWithoutCalls: false },
    },
    rest: {
      baseUrl: 'http://127.0.0.1:1/youtube/v3/liveChat/messages',
      minPollIntervalMs: 1,
      requestTimeoutMs: 5000,
    },
    reconnect: { initialDelayMs: 1, maxDelayMs: 5, factor: 2, jitterRatio: 0, maxAttempts: 8 },
    fallback: { enterAfterConsecutiveFailures: 3, retryPrimaryAfterMs: 60_000 },
    readyPollIntervalMs: 1,
    provisional: [],
    ...overrides,
  }
}

/** Writes straight to the store, the way `StateEngine.ingest` does. */
export function storeInbox(store: PersistenceStore): InboxWriter {
  return {
    ingest: (envelopes, checkpoint, hooks) => store.commitIngestBatch(envelopes, checkpoint, hooks),
  }
}

/** Accepts the one Japanese alias the fixtures use; T6 owns the real parser. */
export const testParseCommand: CommandParser = (rawText) =>
  rawText.trim() === 'ごはん' ? { name: 'FEED', argument: null } : null

export interface CountingTokens extends ChatAccessTokens {
  refreshes: number
}

export function fixedTokens(token: string = TEST_ACCESS_TOKEN): CountingTokens {
  return {
    refreshes: 0,
    getAccessToken: () => Promise.resolve(token),
    forceRefresh(): Promise<unknown> {
      this.refreshes += 1
      return Promise.resolve(token)
    },
  }
}

/** One committed source fixture, as the fake servers serve it. */
export function grpcFixture(name: string): Record<string, unknown> {
  return loadSourceFixture('grpc', name).item as Record<string, unknown>
}

export function restFixture(name: string): Record<string, unknown> {
  return loadSourceFixture('rest', name).item as Record<string, unknown>
}
