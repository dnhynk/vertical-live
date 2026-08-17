import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemorySecretVault } from '../../secrets/memory.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { FakeOAuthServer } from '../../testing/fake-oauth-server.js'
import { CLIENT_ID_ENV, CLIENT_SECRET_ENV } from './config.js'
import { parseLoginArgs, runLoginCli } from './login-cli.js'
import { REFRESH_TOKEN_SECRET } from './token-manager.js'
import type { OAuthEndpoints } from './oauth-client.js'

const SYNTHETIC_CLIENT_SECRET = 'synthetic-client-secret-000000'
const SYNTHETIC_REFRESH_TOKEN = 'synthetic-refresh-token-000000000000'

let server: FakeOAuthServer

beforeEach(async () => {
  server = await FakeOAuthServer.start()
})

afterEach(async () => {
  await server.stop()
})

interface Harness {
  readonly lines: string[]
  readonly vault: InMemorySecretVault
  run(argv: string[]): Promise<number>
}

function harness(
  env: NodeJS.ProcessEnv,
  options: { stored?: Record<string, string>; endpoints?: OAuthEndpoints } = {},
): Harness {
  const lines: string[] = []
  const vault = new InMemorySecretVault(options.stored)
  return {
    lines,
    vault,
    run: (argv) =>
      runLoginCli(argv, {
        io: { write: (line) => lines.push(line) },
        env,
        clock: new FakeClock(),
        vault,
        ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
      }),
  }
}

const CREDENTIAL_ENV = {
  [CLIENT_ID_ENV]: 'synthetic-client-id.apps.googleusercontent.com',
  [CLIENT_SECRET_ENV]: SYNTHETIC_CLIENT_SECRET,
}

describe('auth:login CLI', () => {
  it('parses its flags', () => {
    expect(parseLoginArgs([])).toEqual({ revoke: false, help: false })
    expect(parseLoginArgs(['--revoke'])).toEqual({ revoke: true, help: false })
    expect(parseLoginArgs(['-h'])).toEqual({ revoke: false, help: true })
  })

  it('prints usage for --help', async () => {
    const h = harness({})
    expect(await h.run(['--help'])).toBe(0)
    expect(h.lines.join('\n')).toContain('auth:login --revoke')
  })

  it('fails with an actionable message when no client credentials are configured', async () => {
    const h = harness({})
    expect(await h.run([])).toBe(1)
    expect(h.lines.join('\n')).toContain(CLIENT_ID_ENV)
    expect(h.lines.join('\n')).toContain('docs/ops/youtube-auth-setup.md')
  })

  it('--revoke revokes at the endpoint and clears the vault', async () => {
    const h = harness(CREDENTIAL_ENV, {
      stored: { [REFRESH_TOKEN_SECRET]: SYNTHETIC_REFRESH_TOKEN },
      endpoints: server.endpoints,
    })

    expect(await h.run(['--revoke'])).toBe(0)

    expect(server.revoked).toEqual([SYNTHETIC_REFRESH_TOKEN])
    expect(await h.vault.get(REFRESH_TOKEN_SECRET)).toBeUndefined()
    const output = h.lines.join('\n')
    expect(output).toContain('auth_revoked')
    expect(output).not.toContain(SYNTHETIC_REFRESH_TOKEN)
    expect(output).not.toContain(SYNTHETIC_CLIENT_SECRET)
  })

  it('--revoke still deletes the local token when the endpoint is unreachable', async () => {
    const unreachable: OAuthEndpoints = {
      ...server.endpoints,
      // A port nothing listens on: the revoke request fails at the transport.
      revokeUrl: server.endpoints.revokeUrl.replace(/:\d+\//, ':1/'),
    }
    const h = harness(CREDENTIAL_ENV, {
      stored: { [REFRESH_TOKEN_SECRET]: SYNTHETIC_REFRESH_TOKEN },
      endpoints: unreachable,
    })

    expect(await h.run(['--revoke'])).toBe(1)

    expect(await h.vault.get(REFRESH_TOKEN_SECRET)).toBeUndefined()
    expect(h.lines.join('\n')).toContain('myaccount.google.com/permissions')
    expect(h.lines.join('\n')).not.toContain(SYNTHETIC_REFRESH_TOKEN)
  })
})
