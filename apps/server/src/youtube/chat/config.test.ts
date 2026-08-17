import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ChatConfigError, loadChatConfig } from './config.js'

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
    expect(config.liveChatId).toBeNull()
    // Every number the official documentation does not fix must say so.
    expect(config.provisional).toContain('reconnect')
    expect(config.provisional).toContain('fallback')
    expect(config.provisional).toContain('grpc.keepalive')
  })

  it('takes the live chat id from the environment when one is set', () => {
    const config = loadChatConfig({ env: { VL_YOUTUBE_LIVE_CHAT_ID: 'chat_test_env' } })
    expect(config.liveChatId).toBe('chat_test_env')
  })

  it('refuses to request authorDetails while the identity gate is closed', () => {
    const path = withChatSection({ parts: ['id', 'snippet', 'authorDetails'] })
    expect(() => loadChatConfig({ configPath: path })).toThrow(ChatConfigError)
    expect(() => loadChatConfig({ configPath: path })).toThrow(/identity gate is closed/)
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
