import { describe, expect, it, vi } from 'vitest'

import { FakeClock } from '../testing/fake-clock.js'
import { loadSupervisorConfig } from './config.js'
import { runKillCli } from './kill-cli.js'
import {
  AdminKillEndpoint,
  KillSwitchFileWatcher,
  type KillSwitchFs,
  type KillSwitchRequest,
} from './kill-switch.js'

/**
 * The three kill-switch paths (TASK_SPECS §T12 acceptance 2, spec §9.1 비상 중지,
 * §10.2 loopback + token). Each is tested on its own, because the reason there
 * are three is that they fail in different ways.
 */

const config = loadSupervisorConfig().killSwitch
const TOKEN = 'synthetic-admin-token'

function memoryFs(initial: Record<string, string> = {}): KillSwitchFs & {
  readonly files: Map<string, string>
} {
  const files = new Map(Object.entries(initial))
  return {
    files,
    exists: (path) => files.has(path),
    read: (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return value
    },
    write: (path, contents) => {
      files.set(path, contents)
    },
    remove: (path) => {
      files.delete(path)
    },
  }
}

describe('path 1: POST /admin/kill', () => {
  const endpoint = (killed: KillSwitchRequest[], token: string | null = TOKEN) =>
    new AdminKillEndpoint({
      token,
      clock: new FakeClock(),
      onKill: (request) => killed.push(request),
    })

  it('accepts a loopback request with the vault token', () => {
    const killed: KillSwitchRequest[] = []
    const response = endpoint(killed).handle({
      authorization: `Bearer ${TOKEN}`,
      remoteAddress: '127.0.0.1',
      body: { reason: 'operator stop' },
    })

    expect(response.status).toBe(202)
    expect(killed).toEqual([
      { source: 'http', reason: 'operator stop', at: '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('refuses a request from off the loopback interface (spec §10.2)', () => {
    const killed: KillSwitchRequest[] = []
    const response = endpoint(killed).handle({
      authorization: `Bearer ${TOKEN}`,
      remoteAddress: '10.0.0.4',
      body: null,
    })

    expect(response.status).toBe(403)
    expect(killed).toEqual([])
  })

  it('refuses a wrong, absent or unconfigured token', () => {
    const killed: KillSwitchRequest[] = []
    const request = { remoteAddress: '127.0.0.1', body: null }

    expect(endpoint(killed).handle({ ...request, authorization: null }).status).toBe(401)
    expect(endpoint(killed).handle({ ...request, authorization: 'Bearer nope' }).status).toBe(401)
    // No token configured is a closed door, not an open one.
    expect(
      endpoint(killed, null).handle({ ...request, authorization: `Bearer ${TOKEN}` }).status,
    ).toBe(401)
    expect(killed).toEqual([])
  })

  it('accepts an empty body and bounds the reason it echoes', () => {
    const killed: KillSwitchRequest[] = []
    endpoint(killed).handle({
      authorization: `Bearer ${TOKEN}`,
      remoteAddress: '127.0.0.1',
      body: null,
    })
    endpoint(killed).handle({
      authorization: `Bearer ${TOKEN}`,
      remoteAddress: '127.0.0.1',
      body: { reason: `<script>${'x'.repeat(300)}` },
    })

    expect(killed[0]?.reason).toBe('admin_http')
    expect(killed[1]?.reason.length).toBeLessThanOrEqual(120)
    expect(killed[1]?.reason).not.toContain('<')
  })
})

describe('path 2: the local flag file', () => {
  it('fires once when the flag appears, and re-arms when it is removed', async () => {
    const clock = new FakeClock()
    const fs = memoryFs()
    const killed: KillSwitchRequest[] = []
    const watcher = new KillSwitchFileWatcher({
      config,
      clock,
      fs,
      onKill: (request) => killed.push(request),
    })

    watcher.start()
    expect(killed).toEqual([])

    fs.write(config.flagFile, 'operator_stopped_the_run\n')
    await clock.advance(config.pollIntervalMs)
    expect(killed).toHaveLength(1)
    expect(killed[0]).toMatchObject({ source: 'file', reason: 'operator_stopped_the_run' })

    // Still there on the next poll: one flag is one kill, not one per poll.
    await clock.advance(config.pollIntervalMs)
    expect(killed).toHaveLength(1)

    fs.remove(config.flagFile)
    await clock.advance(config.pollIntervalMs)
    fs.write(config.flagFile, 'again')
    await clock.advance(config.pollIntervalMs)
    expect(killed).toHaveLength(2)

    watcher.stop()
  })

  it('honours a flag left from the previous run before anything goes live', () => {
    const killed: KillSwitchRequest[] = []
    const watcher = new KillSwitchFileWatcher({
      config,
      clock: new FakeClock(),
      fs: memoryFs({ [config.flagFile]: 'left_over' }),
      onKill: (request) => killed.push(request),
    })

    watcher.start()

    expect(killed).toHaveLength(1)
    watcher.stop()
  })

  it('falls back to a stable reason when the flag cannot be read', () => {
    const killed: KillSwitchRequest[] = []
    const fs = memoryFs({ [config.flagFile]: '' })
    const watcher = new KillSwitchFileWatcher({
      config,
      clock: new FakeClock(),
      fs: {
        ...fs,
        read: () => {
          throw new Error('EACCES')
        },
      },
      onKill: (request) => killed.push(request),
    })

    watcher.start()

    expect(killed[0]?.reason).toBe('kill_switch_file')
    watcher.stop()
  })
})

describe('path 3: the CLI', () => {
  const cliDeps = (fs: KillSwitchFs, fetchImpl: typeof fetch, token = TOKEN) => ({
    io: { write: (line: string) => lines.push(line) },
    config: loadSupervisorConfig(),
    baseUrl: 'http://127.0.0.1:8787',
    adminToken: () => Promise.resolve<string | undefined>(token),
    clock: new FakeClock(),
    fetchImpl,
    fs,
  })
  let lines: string[] = []

  it('stops the run over HTTP when the server is answering', async () => {
    lines = []
    const fs = memoryFs()
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    const code = await runKillCli(
      ['--reason', 'operator'],
      cliDeps(fs, fetchImpl as unknown as typeof fetch),
    )

    expect(code).toBe(0)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8787/admin/kill')
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(fs.files.size).toBe(0)
    expect(lines.join('\n')).toContain('kill accepted over http')
  })

  it('falls back to the flag file when HTTP cannot be reached', async () => {
    lines = []
    const fs = memoryFs()
    const code = await runKillCli(
      ['--reason', 'wedged'],
      cliDeps(fs, (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch),
    )

    expect(code).toBe(0)
    expect(fs.files.get(config.flagFile)).toContain('wedged')
    expect(lines.join('\n')).toContain('kill flag written')
  })

  it('fails rather than falling back when --via http was asked for', async () => {
    lines = []
    const fs = memoryFs()
    const code = await runKillCli(
      ['--via', 'http'],
      cliDeps(fs, (async () => new Response(null, { status: 500 })) as unknown as typeof fetch),
    )

    expect(code).toBe(1)
    expect(fs.files.size).toBe(0)
  })

  it('writes the flag directly with --via file', async () => {
    lines = []
    const fs = memoryFs()
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    const code = await runKillCli(
      ['--via', 'file'],
      cliDeps(fs, fetchImpl as unknown as typeof fetch),
    )

    expect(code).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(fs.files.get(config.flagFile)).toContain('operator_cli')
  })

  it('clears the flag without restarting anything', async () => {
    lines = []
    const fs = memoryFs({ [config.flagFile]: 'stop' })
    const code = await runKillCli(
      ['--clear'],
      cliDeps(fs, (() => {
        throw new Error('must not be called')
      }) as unknown as typeof fetch),
    )

    expect(code).toBe(0)
    expect(fs.files.size).toBe(0)
    expect(lines.join('\n')).toContain('cleared')
  })

  it('refuses an argument it does not understand', async () => {
    lines = []
    const code = await runKillCli(
      ['--force'],
      cliDeps(memoryFs(), (() => {
        throw new Error('must not be called')
      }) as unknown as typeof fetch),
    )

    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('unknown argument')
  })
})
