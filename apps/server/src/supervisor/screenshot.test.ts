import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import type { ObsRequester } from '../obs/requester.js'
import { FakeClock } from '../testing/fake-clock.js'
import { loadSupervisorConfig } from './config.js'
import { DiagnosticScreenshotRecorder, type ScreenshotFs } from './screenshot.js'

/**
 * Diagnostic screenshots (spec §9.4). The important claim is a negative one:
 * a screenshot is stored and never turned into a verdict, because "정적 장면은
 * 오탐이고 배경만 움직이는 고장 화면은 미탐"이다.
 */

const config = { ...loadSupervisorConfig().screenshot, enabled: true, keep: 3 }

function memoryFs(initial: readonly string[] = []): ScreenshotFs & { readonly files: string[] } {
  const files = [...initial]
  return {
    files,
    ensureDirectory: () => {},
    list: () => [...files],
    remove: (path) => {
      const name = path.split(/[\\/]/).pop() ?? path
      const index = files.indexOf(name)
      if (index >= 0) files.splice(index, 1)
    },
  }
}

function requester(call = vi.fn(async () => undefined)): ObsRequester {
  return {
    call: call as unknown as ObsRequester['call'],
    on: () => {},
    off: () => {},
  }
}

describe('DiagnosticScreenshotRecorder', () => {
  it('asks OBS to save a file with a path-safe UTC name', async () => {
    const call = vi.fn(async () => undefined)
    const recorder = new DiagnosticScreenshotRecorder({
      source: requester(call),
      config,
      clock: new FakeClock(),
      fs: memoryFs(),
    })

    const result = await recorder.capture()

    expect(result.saved).toBe(true)
    const [request, payload] = call.mock.calls[0] as unknown as [
      string,
      { imageFilePath: string; sourceName: string; imageFormat: string },
    ]
    expect(request).toBe('SaveSourceScreenshot')
    expect(payload.sourceName).toBe(config.sourceName)
    // `:` is not a legal Windows path character (BOARD D-2).
    const fileName = payload.imageFilePath.split(/[\\/]/).pop()
    expect(fileName).toBe('screenshot-2026-01-01T00-00-00-000Z.jpg')
    // `:` is legal only in a drive prefix, never in a file name.
    expect(fileName).not.toContain(':')
  })

  it('keeps the archive bounded (spec §9.1 rolling archive)', async () => {
    const fs = memoryFs([
      'screenshot-2026-01-01T00-00-01-000Z.jpg',
      'screenshot-2026-01-01T00-00-02-000Z.jpg',
      'screenshot-2026-01-01T00-00-03-000Z.jpg',
      'screenshot-2026-01-01T00-00-04-000Z.jpg',
      'unrelated.txt',
    ])
    const recorder = new DiagnosticScreenshotRecorder({
      source: requester(),
      config,
      clock: new FakeClock(),
      fs,
    })

    const result = await recorder.capture()

    expect(result.removed).toEqual(['screenshot-2026-01-01T00-00-01-000Z.jpg'])
    expect(fs.files).toContain('unrelated.txt')
  })

  it('records a failed capture instead of throwing', async () => {
    const recorder = new DiagnosticScreenshotRecorder({
      source: requester(vi.fn(() => Promise.reject(new Error('no such input')))),
      config,
      clock: new FakeClock(),
      fs: memoryFs(),
    })

    const result = await recorder.capture()

    expect(result).toMatchObject({ saved: false, error: 'no such input' })
  })

  it('does nothing while it is disabled', async () => {
    const call = vi.fn(async () => undefined)
    const recorder = new DiagnosticScreenshotRecorder({
      source: requester(call),
      config: { ...config, enabled: false },
      clock: new FakeClock(),
      fs: memoryFs(),
    })

    recorder.start()
    await expect(recorder.capture()).resolves.toMatchObject({ saved: false, error: 'disabled' })
    expect(recorder.running).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })

  it('captures on the interval once started', async () => {
    const clock = new FakeClock()
    const call = vi.fn(async () => undefined)
    const recorder = new DiagnosticScreenshotRecorder({
      source: requester(call),
      config,
      clock,
      fs: memoryFs(),
    })

    recorder.start()
    await clock.advance(config.intervalMs)
    expect(call).toHaveBeenCalledTimes(1)
    recorder.stop()
    await clock.advance(config.intervalMs * 2)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('never feeds a freeze verdict: it produces no health signal at all (spec §9.4)', () => {
    // Structural, because the rule is about what must *not* exist: the module
    // neither imports the signal contract nor the aggregator, so there is no
    // path from a saved image to the state machine.
    const source = readFileSync(fileURLToPath(new URL('./screenshot.ts', import.meta.url)), 'utf8')
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import'))
      .join('\n')

    expect(imports).not.toContain('health/types.js')
    expect(imports).not.toContain('./signals.js')
    expect(imports).not.toContain('./supervisor.js')
    // No hashing either: a scene hash is exactly the false signal §9.4 rules out.
    expect(source).not.toContain('createHash')
  })
})
