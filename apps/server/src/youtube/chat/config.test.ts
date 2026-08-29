import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ChatConfigError, MAX_TIMER_DELAY_MS, loadChatConfig } from './config.js'

const REPOSITORY_CONFIG = new URL('../../../../../config/default.json', import.meta.url)

/** The committed file is the base, so a test cannot pass against a stale shape. */
function withChatSection(overrides: Record<string, unknown>): string {
  const parsed = JSON.parse(readFileSync(REPOSITORY_CONFIG, 'utf8')) as {
    youtube: { chat: Record<string, unknown> }
  }
  parsed.youtube.chat = { ...parsed.youtube.chat, ...overrides }
  const directory = mkdtempSync(join(tmpdir(), 'vl-chat-config-'))
  const file = join(directory, 'default.json')
  writeFileSync(file, JSON.stringify(parsed))
  return file
}

describe('loadChatConfig', () => {
  it('reads the committed configuration', () => {
    const config = loadChatConfig()
    expect(config.enabled).toBe(false)
    expect(config.parts).toEqual(['id', 'snippet'])
    expect(config.grpc.endpoint).toBe('youtube.googleapis.com:443')
    // Not a free number: it has to stay under `supervisor.signalStaleAfterMs` or
    // the chat source's own pacing wait reads as an outage. Raised to 90,000 on
    // 2026-08-29 and put back within three minutes for exactly that reason —
    // `youtube/quota/budget.test.ts` pins the conflict.
    // Longer than `supervisor.signalStaleAfterMs` on purpose, which is only safe
    // because `health.ts` reports a pacing wait inside its delay as `ok`. The two
    // are asserted together in `youtube/quota/budget.test.ts`.
    expect(config.grpcStreamMinStartIntervalMs).toBe(120_000)
    expect(config.liveChatId).toBeNull()
    // Every number the official documentation does not fix must say so.
    expect(config.provisional).toContain('reconnect')
    expect(config.provisional).toContain('fallback')
    expect(config.provisional).toContain('grpc.keepalive')
    expect(config.provisional).toContain('grpcStreamMinStartIntervalMs')
  })

  it('turns the chat source on from the environment, so the host needs no config edit', () => {
    // config keeps it off for CI and development; the broadcast host sets the
    // env like it does for the OBS and broadcast integrations (§T26).
    expect(loadChatConfig({ env: { VL_YOUTUBE_CHAT_ENABLED: 'true' } }).enabled).toBe(true)
    expect(loadChatConfig({ env: {} }).enabled).toBe(false)
  })

  it('refuses a chat switch that is not a boolean', () => {
    expect(() => loadChatConfig({ env: { VL_YOUTUBE_CHAT_ENABLED: 'yes' } })).toThrow()
  })

  it('takes the live chat id from the environment when one is set', () => {
    const config = loadChatConfig({ env: { VL_YOUTUBE_LIVE_CHAT_ID: 'chat_test_env' } })
    expect(config.liveChatId).toBe('chat_test_env')
  })

  it('overrides the gRPC stream start interval from the environment', () => {
    const config = loadChatConfig({
      env: { VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS: '30000' },
    })
    expect(config.grpcStreamMinStartIntervalMs).toBe(30_000)
  })

  it('refuses a non-positive or non-integer gRPC stream start interval', () => {
    for (const value of ['0', '-1', '1.5', 'not-a-number']) {
      expect(() =>
        loadChatConfig({
          env: { VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS: value },
        }),
      ).toThrow(/grpcStreamMinStartIntervalMs/)
    }
  })

  it('accepts the Node timer maximum and rejects overflow from JSON and env', () => {
    expect(
      loadChatConfig({
        env: { VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS: String(MAX_TIMER_DELAY_MS) },
      }).grpcStreamMinStartIntervalMs,
    ).toBe(MAX_TIMER_DELAY_MS)

    const overflow = MAX_TIMER_DELAY_MS + 1
    expect(() =>
      loadChatConfig({
        env: { VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS: String(overflow) },
      }),
    ).toThrow(/must be <= 2147483647/)
    expect(() =>
      loadChatConfig({
        configPath: withChatSection({ grpcStreamMinStartIntervalMs: overflow }),
      }),
    ).toThrow(/must be <= 2147483647/)
  })

  it('requests no author identity while the consent gate is closed', () => {
    // BOARD A-1 / D-9 closed: exactly the two parts spec §7.2 always allows.
    const config = loadChatConfig({ identityGateOpen: false })
    expect(config.parts).toEqual(['id', 'snippet'])
    expect(config.identityGateOpen).toBe(false)
  })

  it('adds authorDetails only when the consent gate is open', () => {
    // D-9: opening the gate is what adds the part, so a viewer who sends JOIN
    // can be recognized (spec §7.2 "authorDetails는 identity feature gate가
    // 승인된 경우에만 추가한다").
    const config = loadChatConfig({ identityGateOpen: true })
    expect(config.parts).toEqual(['id', 'snippet', 'authorDetails'])
    expect(config.identityGateOpen).toBe(true)
  })

  it('refuses a config file that names authorDetails itself, gate open or shut', () => {
    const path = withChatSection({ parts: ['id', 'snippet', 'authorDetails'] })
    for (const identityGateOpen of [false, true]) {
      expect(() => loadChatConfig({ configPath: path, identityGateOpen })).toThrow(ChatConfigError)
      expect(() => loadChatConfig({ configPath: path, identityGateOpen })).toThrow(
        /decided by engine\.identityGateOpen/,
      )
    }
  })

  it('refuses parts the API does not define', () => {
    const path = withChatSection({ parts: ['id', 'contentDetails'] })
    expect(() => loadChatConfig({ configPath: path })).toThrow(/unsupported value/)
  })

  it('refuses any parts list that is not exactly id,snippet', () => {
    // Review round 1 (M2): a subset was accepted. Dropping `id` would leave the
    // envelope without a message id, i.e. without a dedupe key (§7.3(1)(4)).
    for (const parts of [['snippet'], ['id'], [], ['id', 'snippet', 'snippet']]) {
      expect(() => loadChatConfig({ configPath: withChatSection({ parts }) })).toThrow(
        /parts must be exactly id,snippet/,
      )
    }
    // The correct list still loads, in either order.
    expect(
      loadChatConfig({ configPath: withChatSection({ parts: ['snippet', 'id'] }) }).parts,
    ).toEqual(['snippet', 'id'])
  })

  it('refuses a maxResults outside the documented 200–2000 range', () => {
    expect(() => loadChatConfig({ configPath: withChatSection({ maxResults: 50 }) })).toThrow(
      /between 200 and 2000/,
    )
    expect(() => loadChatConfig({ configPath: withChatSection({ maxResults: 5000 }) })).toThrow(
      /between 200 and 2000/,
    )
  })

  it('refuses a non-positive poll floor', () => {
    const path = withChatSection({
      rest: {
        baseUrl: 'https://example.invalid/messages',
        minPollIntervalMs: 0,
        requestTimeoutMs: 1000,
      },
    })
    expect(() => loadChatConfig({ configPath: path })).toThrow(/minPollIntervalMs/)
  })

  it('has no upper bound on the poll interval to clamp the server with', () => {
    // Round 1 (M1): a ceiling would make us poll sooner than the server asked.
    const config = loadChatConfig()
    expect(Object.keys(config.rest)).toEqual(['baseUrl', 'minPollIntervalMs', 'requestTimeoutMs'])
  })
})
