import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WS_URL,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  authenticatedWsUrl,
  isLoopbackWebSocketUrl,
  readRendererConfig,
} from './config'
import { RendererLog } from './read-model/log'
import { computeStageScale } from './stage'
import { FakeClock } from './testing/fakes'

function read(search: string): { config: ReturnType<typeof readRendererConfig>; log: RendererLog } {
  const log = new RendererLog(new FakeClock())
  const config = readRendererConfig({
    search,
    log,
    generateRendererId: () => 'renderer-generated',
  })
  return { config, log }
}

describe('renderer config (spec §10.2, BOARD A-14)', () => {
  it('defaults to the broadcast mode and the loopback server', () => {
    const { config } = read('')
    expect(config.mode).toBe('broadcast')
    expect(config.wsUrl).toBe(DEFAULT_WS_URL)
    expect(config.rendererId).toBe('renderer-generated')
  })

  it('accepts the two documented modes', () => {
    expect(read('?mode=dev').config.mode).toBe('dev')
    expect(read('?mode=broadcast').config.mode).toBe('broadcast')
  })

  it('falls back to the broadcast screen for an unknown mode', () => {
    const { config, log } = read('?mode=debug')
    expect(config.mode).toBe('broadcast')
    expect(log.entries().some((entry) => entry.code === 'config_mode_rejected')).toBe(true)
  })

  it('allows a loopback server override and refuses anything else', () => {
    expect(read('?ws=ws%3A%2F%2F127.0.0.1%3A9999%2Fws%2Frenderer').config.wsUrl).toBe(
      'ws://127.0.0.1:9999/ws/renderer',
    )
    expect(read('?ws=ws%3A%2F%2Flocalhost%3A8787%2Fws%2Frenderer').config.wsUrl).toBe(
      'ws://localhost:8787/ws/renderer',
    )

    const rejected = read('?ws=ws%3A%2F%2F192.168.1.5%3A8787%2Fws%2Frenderer')
    expect(rejected.config.wsUrl).toBe(DEFAULT_WS_URL)
    expect(rejected.log.entries().some((entry) => entry.code === 'config_ws_rejected')).toBe(true)

    expect(isLoopbackWebSocketUrl('http://127.0.0.1:8787/ws/renderer')).toBe(false)
    expect(isLoopbackWebSocketUrl('wss://example.test/ws/renderer')).toBe(false)
    expect(isLoopbackWebSocketUrl('not a url')).toBe(false)
  })

  it('keeps the renderer token out of the address and in its own field', () => {
    // The server authenticates the upgrade (spec §10.2) and an OBS Browser Source
    // can only pass values through its URL, so the token rides the query string —
    // but it is kept out of `wsUrl`, which is what diagnostics render
    // (R-T8-2 blocker 1, `components/DevPanel.test.tsx`).
    const { config, log } = read('?token=test_renderer_token_0001')
    expect(config.wsUrl).toBe('ws://127.0.0.1:8787/ws/renderer')
    expect(config.wsToken).toBe('test_renderer_token_0001')
    expect(authenticatedWsUrl(config)).toBe(
      'ws://127.0.0.1:8787/ws/renderer?token=test_renderer_token_0001',
    )
    expect(log.entries().some((entry) => entry.code === 'config_token_missing')).toBe(false)

    const overridden = read('?ws=ws%3A%2F%2F127.0.0.1%3A9999%2Fws%2Frenderer&token=abc')
    expect(overridden.config.wsUrl).toBe('ws://127.0.0.1:9999/ws/renderer')
    expect(authenticatedWsUrl(overridden.config)).toBe('ws://127.0.0.1:9999/ws/renderer?token=abc')
  })

  it('says so when no token was supplied instead of inventing one', () => {
    const { config, log } = read('?mode=dev')
    expect(config.wsToken).toBeNull()
    expect(config.wsUrl).toBe(DEFAULT_WS_URL)
    expect(log.entries().some((entry) => entry.code === 'config_token_missing')).toBe(true)
    // No token value is ever logged, only its absence.
    expect(JSON.stringify(log.entries())).not.toContain('token=')
  })

  it('takes a renderer id from the URL only when it fits the contract', () => {
    expect(read('?rendererId=obs-main').config.rendererId).toBe('obs-main')

    const rejected = read('?rendererId=obs%20main')
    expect(rejected.config.rendererId).toBe('renderer-generated')
    expect(
      rejected.log.entries().some((entry) => entry.code === 'config_renderer_id_rejected'),
    ).toBe(true)
  })

  it('lists the numbers that are provisional until a gate approves them', () => {
    const { config } = read('')
    expect(config.provisional).toContain('healthIntervalMs')
    expect(config.provisional).toContain('backoff.initialMs')
  })
})

describe('stage geometry (spec §11 "화면")', () => {
  it('is exactly 1080x1920 with scale 1 in the OBS Browser Source', () => {
    expect([STAGE_WIDTH, STAGE_HEIGHT]).toEqual([1080, 1920])
    expect(computeStageScale(1080, 1920)).toBe(1)
  })

  it('only scales, so the layout stays in broadcast pixels', () => {
    expect(computeStageScale(540, 960)).toBe(0.5)
    expect(computeStageScale(1920, 1080)).toBeCloseTo(1080 / 1920, 10)
    expect(computeStageScale(0, 0)).toBe(1)
  })
})
