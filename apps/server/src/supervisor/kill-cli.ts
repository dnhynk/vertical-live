import { systemClock, type Clock } from '../clock.js'
import type { SupervisorConfig } from './config.js'
import { clearKillSwitchFlag, nodeKillSwitchFs, writeKillSwitchFlag, type KillSwitchFs } from './kill-switch.js'

/**
 * `kill` CLI — path 3 of the kill switch (spec §9.1 "비상 중지 권한", §11).
 *
 * It tries HTTP first because that stops the run *now*, and falls back to the
 * flag file because the reason an operator reaches for a kill switch is often
 * that the process has stopped answering. Either way the operator gets one
 * command that works, and the output says which path actually took effect.
 *
 * `--clear` removes the flag file. It does not restart anything: leaving
 * `safe_stopped` means starting the process again (spec §9.2).
 */

export interface KillCliIo {
  write(line: string): void
}

export interface KillCliDeps {
  readonly io: KillCliIo
  readonly config: SupervisorConfig
  /** Base URL of the loopback HTTP surface, e.g. `http://127.0.0.1:8787`. */
  readonly baseUrl: string
  /** `server.adminToken` from the vault; `undefined` skips the HTTP path. */
  readonly adminToken: () => Promise<string | undefined>
  readonly clock?: Clock
  readonly fetchImpl?: typeof fetch
  readonly fs?: KillSwitchFs
}

const USAGE = `usage:
  kill [--reason <text>] [--via auto|http|file]   stop the run (spec §9.2 safe_stopped)
  kill --clear                                    remove the local flag file

--via auto (default) posts to /admin/kill and falls back to the flag file.
Leaving safe_stopped is starting the process again, never this command.`

export async function runKillCli(argv: readonly string[], deps: KillCliDeps): Promise<number> {
  const clock = deps.clock ?? systemClock
  const fs = deps.fs ?? nodeKillSwitchFs
  const args = parseArgs(argv)
  if ('error' in args) {
    deps.io.write(`${args.error}\n${USAGE}`)
    return 1
  }
  if (args.help) {
    deps.io.write(USAGE)
    return 0
  }
  if (args.clear) {
    clearKillSwitchFlag(deps.config.killSwitch, fs)
    deps.io.write(`cleared ${deps.config.killSwitch.flagFile}`)
    return 0
  }

  const reason = args.reason ?? 'operator_cli'

  if (args.via === 'http' || args.via === 'auto') {
    const http = await postKill(deps, reason)
    if (http.ok) {
      deps.io.write(`kill accepted over http: ${reason}`)
      return 0
    }
    deps.io.write(`http kill failed: ${http.error}`)
    if (args.via === 'http') return 1
  }

  writeKillSwitchFlag(deps.config.killSwitch, reason, clock.nowUtcIso(), fs)
  deps.io.write(`kill flag written: ${deps.config.killSwitch.flagFile}`)
  return 0
}

async function postKill(
  deps: KillCliDeps,
  reason: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  let token: string | undefined
  try {
    token = await deps.adminToken()
  } catch (error) {
    return { ok: false, error: `vault_unavailable:${errorToken(error)}` }
  }
  if (token === undefined || token === '') {
    return { ok: false, error: 'admin_token_not_configured' }
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${deps.baseUrl}/admin/kill`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    return response.status >= 200 && response.status < 300
      ? { ok: true }
      : { ok: false, error: `http_${response.status}` }
  } catch (error) {
    return { ok: false, error: errorToken(error) }
  }
}

interface ParsedArgs {
  readonly reason: string | null
  readonly via: 'auto' | 'http' | 'file'
  readonly clear: boolean
  readonly help: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs | { readonly error: string } {
  let reason: string | null = null
  let via: ParsedArgs['via'] = 'auto'
  let clear = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--clear') clear = true
    else if (arg === '--reason') {
      const value = argv[index + 1]
      if (value === undefined) return { error: 'missing value for --reason' }
      reason = value
      index += 1
    } else if (arg === '--via') {
      const value = argv[index + 1]
      if (value !== 'auto' && value !== 'http' && value !== 'file') {
        return { error: `--via must be auto, http or file (got ${String(value)})` }
      }
      via = value
      index += 1
    } else return { error: `unknown argument: ${String(arg)}` }
  }

  return { reason, via, clear, help }
}

function errorToken(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code ?? error.name
  }
  return 'unknown_error'
}
