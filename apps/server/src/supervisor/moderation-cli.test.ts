import { describe, expect, it, vi } from 'vitest'

import { runModerationCli, type ModerationCliDeps } from './moderation-cli.js'

/**
 * `npm run moderation -w @vl/server -- --reason <token> [--clear]` (TASK_SPECS
 * §T22 acceptance 1).
 *
 * The failure path carries as much weight as the success one: unlike the kill
 * CLI this command has no flag-file fallback, so "the server did not answer"
 * must be unmistakable rather than a silent success.
 */

const TOKEN = 'synthetic-admin-token'

function cli(overrides: Partial<ModerationCliDeps> = {}): {
  readonly deps: ModerationCliDeps
  readonly lines: string[]
} {
  const lines: string[] = []
  const deps: ModerationCliDeps = {
    io: { write: (line) => lines.push(line) },
    baseUrl: 'http://127.0.0.1:8787',
    adminToken: () => Promise.resolve(TOKEN),
    fetchImpl: vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))) as typeof fetch,
    ...overrides,
  }
  return { deps, lines }
}

describe('moderation CLI', () => {
  it('posts an approved reason to /admin/moderation with the vault token', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })))
    const { deps, lines } = cli({ fetchImpl: fetchImpl as unknown as typeof fetch })

    const code = await runModerationCli(['--reason', 'pii_exposure', '--note', 'synthetic'], deps)

    expect(code).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8787/admin/moderation')
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(init.body as string)).toEqual({
      reason: 'pii_exposure',
      note: 'synthetic',
    })
    expect(lines.join('\n')).toContain('moderation reported: pii_exposure')
  })

  it('refuses a token that is not on the approved table before any request', async () => {
    const fetchImpl = vi.fn()
    const { deps, lines } = cli({ fetchImpl: fetchImpl as unknown as typeof fetch })

    const code = await runModerationCli(['--reason', 'chat_is_bad'], deps)

    expect(code).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('unknown reason token')
    expect(lines.join('\n')).toContain('targeted_harassment')
  })

  it('posts a clear to /admin/moderation/clear', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })))
    const { deps, lines } = cli({ fetchImpl: fetchImpl as unknown as typeof fetch })

    const code = await runModerationCli(['--clear'], deps)

    expect(code).toBe(0)
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(
      'http://127.0.0.1:8787/admin/moderation/clear',
    )
    expect(lines.join('\n')).toContain('safe_stopped')
  })

  it('fails loudly when the server does not answer — there is no flag file', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const { deps, lines } = cli({
      fetchImpl: (() => Promise.reject(error)) as unknown as typeof fetch,
    })

    const code = await runModerationCli(['--reason', 'targeted_harassment'], deps)

    expect(code).toBe(1)
    const output = lines.join('\n')
    expect(output).toContain('moderation report failed')
    expect(output).toContain('ECONNREFUSED')
    // The operator is pointed at the command that *does* work on a wedged
    // process, because this one deliberately does not (see `moderation-cli.ts`).
    expect(output).toContain('npm run kill')
  })

  it('fails on a refusal from the server and names the status', async () => {
    const { deps, lines } = cli({
      fetchImpl: (() =>
        Promise.resolve(new Response(null, { status: 401 }))) as unknown as typeof fetch,
    })

    const code = await runModerationCli(['--reason', 'targeted_harassment'], deps)

    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('http_401')
  })

  it('fails when the admin token is not in the vault', async () => {
    const fetchImpl = vi.fn()
    const { deps, lines } = cli({
      adminToken: () => Promise.resolve(undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const code = await runModerationCli(['--reason', 'targeted_harassment'], deps)

    expect(code).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('admin_token_not_configured')
  })

  it('rejects a malformed invocation and prints the approved vocabulary', async () => {
    const missingReason = cli()
    const unknownArg = cli()
    const both = cli()
    const help = cli()

    expect(await runModerationCli([], missingReason.deps)).toBe(1)
    expect(missingReason.lines.join('\n')).toContain('missing --reason')
    expect(await runModerationCli(['--nope'], unknownArg.deps)).toBe(1)
    expect(await runModerationCli(['--clear', '--reason', 'pii_exposure'], both.deps)).toBe(1)
    expect(both.lines.join('\n')).toContain('--clear takes no --reason')
    expect(await runModerationCli(['--help'], help.deps)).toBe(0)
    expect(help.lines.join('\n')).toContain('sexual_or_self_harm_risk')
  })
})
