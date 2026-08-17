import { describe, expect, it } from 'vitest'
import { parseSecretName, runSecretsCli } from './cli.js'
import { InMemorySecretVault } from './memory.js'

const SYNTHETIC_STREAM_KEY = 'synthetic-stream-key-0123456789'

function harness(initial?: Record<string, string>): {
  lines: string[]
  vault: InMemorySecretVault
  run: (argv: string[], stdin?: string) => Promise<number>
} {
  const lines: string[] = []
  const vault = new InMemorySecretVault(initial)
  return {
    lines,
    vault,
    run: (argv, stdin = '') =>
      runSecretsCli(argv, {
        vault,
        io: { write: (line) => lines.push(line), readStdin: async () => stdin },
      }),
  }
}

describe('secrets CLI', () => {
  it('stores a value read from stdin and never echoes it', async () => {
    const h = harness()
    const code = await h.run(['set', 'youtube.streamKey'], `${SYNTHETIC_STREAM_KEY}\n`)

    expect(code).toBe(0)
    expect(await h.vault.get('youtube.streamKey')).toBe(SYNTHETIC_STREAM_KEY)
    expect(h.lines.join('\n')).not.toContain(SYNTHETIC_STREAM_KEY)
    expect(h.lines.join('\n')).toContain(`${SYNTHETIC_STREAM_KEY.length} characters`)
  })

  it('lists which secrets are set without revealing values', async () => {
    const h = harness({ 'youtube.streamKey': SYNTHETIC_STREAM_KEY })
    expect(await h.run(['list'])).toBe(0)

    const output = h.lines.join('\n')
    expect(output).toContain('set      youtube.streamKey')
    expect(output).toContain('missing  obs.websocketPassword')
    expect(output).not.toContain(SYNTHETIC_STREAM_KEY)
  })

  it('deletes and reports when there was nothing to delete', async () => {
    const h = harness({ 'server.adminToken': 'synthetic-admin-token-0000' })
    expect(await h.run(['delete', 'server.adminToken'])).toBe(0)
    expect(await h.run(['delete', 'server.adminToken'])).toBe(0)
    expect(h.lines).toEqual(['deleted server.adminToken', 'nothing stored under server.adminToken'])
  })

  it('rejects unknown names, unknown commands and empty values', async () => {
    const h = harness()
    expect(await h.run(['set', 'youtube.notASecret'], 'x')).toBe(1)
    expect(await h.run(['frobnicate'])).toBe(1)
    expect(await h.run(['set', 'youtube.streamKey'], '\n')).toBe(1)
    expect(await h.run([])).toBe(1)
    expect(h.lines.join('\n')).toContain('usage:')
    expect(h.vault.storedNames()).toEqual([])
  })

  it('parses only the known secret names', () => {
    expect(parseSecretName('youtube.oauthRefreshToken')).toBe('youtube.oauthRefreshToken')
    expect(parseSecretName('anything.else')).toBeUndefined()
    expect(parseSecretName(undefined)).toBeUndefined()
  })
})
