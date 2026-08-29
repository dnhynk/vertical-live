import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { loadObsConfig } from './config.js'

/**
 * Guards the shipped OBS profile in `ops/obs/` against the official recommended
 * settings it claims to implement, so `docs/ops/obs-setup.md`'s comparison table
 * cannot drift away from the files (TASK_SPECS §T2 acceptance 3).
 *
 * Sources, read 2026-08-17:
 *   [S26] https://support.google.com/youtube/answer/2853702?hl=en
 *   [S27] https://support.google.com/youtube/answer/10364924?hl=en
 *   obs-studio plugins/rtmp-services/data/services.json ("YouTube - RTMPS")
 */

const OPS_OBS = fileURLToPath(new URL('../../../../ops/obs/', import.meta.url))
const PROFILE = join(OPS_OBS, 'profiles', 'vertical-live')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Minimal `basic.ini` reader: OBS writes plain `[Section]` / `key=value`. */
function readIni(path: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current = ''
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    // OBS writes basic.ini with a UTF-8 BOM.
    const line = (rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine).trim()
    if (line === '') {
      continue
    }
    const section = /^\[(.+)\]$/.exec(line)
    if (section?.[1] !== undefined) {
      current = section[1]
      sections[current] = {}
      continue
    }
    const separator = line.indexOf('=')
    if (separator > 0) {
      const target = (sections[current] ??= {})
      target[line.slice(0, separator)] = line.slice(separator + 1)
    }
  }
  return sections
}

describe('ops/obs profile — video and audio (spec §11 "화면", [S26])', () => {
  const ini = readIni(join(PROFILE, 'basic.ini'))

  it('renders and outputs a 9:16 1080x1920 canvas', () => {
    expect(ini['Video']).toMatchObject({
      BaseCX: '1080',
      BaseCY: '1920',
      OutputCX: '1080',
      OutputCY: '1920',
    })
  })

  it('runs at 30fps via the common-FPS setting', () => {
    // FPSType 0 = "Common FPS Values"; FPSCommon is the value as a string
    // (obs-studio frontend/widgets/OBSBasic.cpp, GetFPSCommon).
    expect(ini['Video']?.['FPSType']).toBe('0')
    expect(ini['Video']?.['FPSCommon']).toBe('30')
  })

  it('uses the [S26] audio format: 128 kbps AAC, 44.1 kHz, stereo', () => {
    expect(ini['Audio']).toMatchObject({ SampleRate: '44100', ChannelSetup: 'Stereo' })
    expect(ini['AdvOut']).toMatchObject({ AudioEncoder: 'ffmpeg_aac', Track1Bitrate: '128' })
  })

  it('streams with the portable software H.264 encoder and honours the service recommendations', () => {
    expect(ini['Output']?.['Mode']).toBe('Advanced')
    expect(ini['AdvOut']?.['Encoder']).toBe('obs_x264')
    expect(ini['AdvOut']?.['ApplyServiceSettings']).toBe('true')
    expect(ini['Stream1']?.['IgnoreRecommended']).toBe('false')
  })
})

describe('ops/obs profile — stream encoder ([S26])', () => {
  const encoder = readJson(join(PROFILE, 'streamEncoder.json'))

  it('encodes H.264 CBR under what this host can actually send', () => {
    // [S26] recommends 10 Mbps for 1080p @30fps, and the profile asked for it
    // until 2026-08-29. The host could not deliver it: over an 18-minute sample
    // OBS reported 1,023,900,636 bytes in 1,080,533 ms — 7.58 Mbit/s against a
    // 10 Mbit/s ask — with outputCongestion 0.76..0.90 and 8,423 of 32,416
    // output frames dropped (26%). renderSkipped was 0 the whole time, so the
    // scene composited fine and the loss was entirely in getting frames out.
    //
    // A recommendation is a ceiling for a link that can carry it. 6 Mbps sits
    // under the measured throughput with headroom, and a clean 6 Mbps reaches a
    // viewer better than a 10 Mbps stream that drops a quarter of its frames.
    // Re-measure before raising this: the number belongs to the uplink, not to
    // the encoder.
    expect(encoder['rate_control']).toBe('CBR')
    expect(encoder['bitrate']).toBe(6_000)
    // use_bufsize false makes obs-x264 set vbv buffer = bitrate (plugins/obs-x264/obs-x264.c).
    expect(encoder['use_bufsize']).toBe(false)
  })

  it('emits a keyframe every 2 seconds', () => {
    // [S26] "Recommended 2 seconds", and services.json recommends keyint 2.
    expect(encoder['keyint_sec']).toBe(2)
  })

  it('uses 2 B-frames and 1 reference frame', () => {
    expect(encoder['bf']).toBe(2)
    expect(encoder['x264opts']).toContain('ref=1')
  })
})

describe('ops/obs profile — RTMPS service ([S27])', () => {
  const service = readJson(join(PROFILE, 'service.json'))
  const settings = service['settings'] as Record<string, unknown>

  it('is the YouTube RTMPS service on port 443', () => {
    expect(service['type']).toBe('rtmp_common')
    expect(settings['service']).toBe('YouTube - RTMPS')
    expect(settings['protocol']).toBe('RTMPS')
    expect(settings['server']).toBe('rtmps://a.rtmps.youtube.com:443/live2')
  })

  it('never carries a stream key (spec §10.2, CLAUDE.md §3)', () => {
    expect(settings['key']).toBeUndefined()
  })
})

describe('ops/obs scene collection', () => {
  const collection = readJson(join(OPS_OBS, 'scenes', 'vertical-live.json'))
  const sources = collection['sources'] as Record<string, unknown>[]
  const browser = sources.find((source) => source['id'] === 'browser_source')
  const scenes = sources.filter((source) => source['id'] === 'scene')

  it('shows the renderer through a 1080x1920 Browser Source', () => {
    const settings = browser?.['settings'] as Record<string, unknown>
    expect(browser?.['name']).toBe('vertical-live-renderer')
    expect(settings['width']).toBe(1080)
    expect(settings['height']).toBe(1920)
    expect(settings['url']).toBe('http://127.0.0.1:5173/?mode=broadcast')
  })

  it('ships the same tokenless URL the server injects into (T17, BOARD A-16)', () => {
    // The scene JSON and `obs.browserSourceUrl` must name the same page: the
    // server rewrites this URL at start-up to add the vault's renderer token,
    // and a scene pointing somewhere else would silently keep the old page.
    const settings = browser?.['settings'] as Record<string, unknown>
    expect(settings['url']).toBe(loadObsConfig().browserSourceUrl)
    expect(String(settings['url'])).not.toContain('token=')
  })

  it('keeps the Browser Source running unattended and without OBS page control', () => {
    const settings = browser?.['settings'] as Record<string, unknown>
    // A 24/7 scene must not tear the page down or reload it on its own; the
    // server drives reloads through `refreshnocache`.
    expect(settings['shutdown']).toBe(false)
    expect(settings['restart_when_active']).toBe(false)
    // ControlLevel::None (obs-browser obs-browser-source.hpp) — the page has no
    // reason to reach into OBS.
    expect(settings['webpage_control_level']).toBe(0)
  })

  it('ships the live and standby scenes the control API switches between', () => {
    expect(scenes.map((scene) => scene['name'])).toEqual(['live', 'standby'])
    expect(collection['current_program_scene']).toBe('live')
  })

  it('binds the live scene item to the Browser Source that exists', () => {
    const live = scenes.find((scene) => scene['name'] === 'live')
    const items = (live?.['settings'] as Record<string, unknown>)['items'] as Record<
      string,
      unknown
    >[]

    expect(items).toHaveLength(1)
    expect(items[0]?.['source_uuid']).toBe(browser?.['uuid'])
    expect(items[0]?.['pos']).toEqual({ x: 0, y: 0 })
  })
})

describe('ops/obs secret hygiene', () => {
  it('has no non-empty "key" field anywhere in the shipped OBS json', () => {
    const offenders: string[] = []

    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`))
        return
      }
      if (typeof value !== 'object' || value === null) {
        return
      }
      for (const [name, child] of Object.entries(value)) {
        if (name === 'key' && typeof child === 'string' && child !== '') {
          offenders.push(`${path}.${name}`)
        }
        walk(child, `${path}.${name}`)
      }
    }

    for (const file of jsonFilesUnder(OPS_OBS)) {
      walk(readJson(file), file)
    }

    expect(offenders).toEqual([])
  })
})

function jsonFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...jsonFilesUnder(path))
    } else if (entry.name.endsWith('.json')) {
      found.push(path)
    }
  }
  return found
}
