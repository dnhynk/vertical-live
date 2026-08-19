import { MODERATION_REASON_TOKENS, isModerationReasonToken } from './moderation-report.js'

/**
 * `moderation` CLI — what an operator actually types after Discord wakes them
 * (spec §12.3, BOARD D-13, TASK_SPECS §T22).
 *
 * It follows the kill CLI's shape (`kill-cli.ts`) with one deliberate
 * difference: **there is no flag-file fallback.**
 *
 * The kill switch has one because its job is to stop a broadcast whose process
 * has stopped answering, and because a flag left on disk must still stop the
 * *next* run (`kill-switch.ts`). A moderation report is the opposite on both
 * counts:
 *
 * 1. Everything a report does — turning the CTA off, alerting, matching the
 *    Gate 0 safe-stop list — happens inside a running supervisor. If the server
 *    is not answering there is no CTA to turn off and no broadcast to stop; the
 *    command for that situation is `npm run kill -w @vl/server -- --reason "<why>"`.
 * 2. A file would leave "moderation degraded" on the disk with no protocol for
 *    clearing it, so a later run whose chat is fine would come up degraded
 *    because of an old incident. That is a false positive, not the 안전 정지 of
 *    §9.2.
 *
 * So this command uses HTTP only, and when HTTP fails it **fails loudly** with a
 * machine-stable token and says what to reach for instead.
 */

export interface ModerationCliIo {
  write(line: string): void
}

export interface ModerationCliDeps {
  readonly io: ModerationCliIo
  /** Base URL of the loopback HTTP surface, e.g. `http://127.0.0.1:8787`. */
  readonly baseUrl: string
  /** `server.adminToken` from the vault — the same one `/admin/kill` uses. */
  readonly adminToken: () => Promise<string | undefined>
  readonly fetchImpl?: typeof fetch
}

const USAGE = `usage:
  moderation --reason <token> [--note <text>]   report a moderation condition (spec §12.3)
  moderation --clear                            withdraw the report (CTA back on)

reason tokens (docs/ops/moderation-call-table.md §2, BOARD D-13):
  ${MODERATION_REASON_TOKENS.join('\n  ')}

There is no flag-file fallback: a report only means something to a running
server. If the server does not answer, stop the broadcast with
\`npm run kill -w @vl/server -- --reason "<why>"\`.
Clearing does not restart a run that already reached safe_stopped — that is
starting the process again (spec §9.2).`

export async function runModerationCli(
  argv: readonly string[],
  deps: ModerationCliDeps,
): Promise<number> {
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
    if (args.reason !== null) {
      deps.io.write(`--clear takes no --reason\n${USAGE}`)
      return 1
    }
    const cleared = await post(deps, '/admin/moderation/clear', {
      ...(args.note === null ? {} : { note: args.note }),
    })
    if (!cleared.ok) {
      deps.io.write(`moderation clear failed: ${cleared.error}`)
      return 1
    }
    deps.io.write(
      'moderation cleared: the CTA comes back on the next evaluation. A run already in safe_stopped is left by starting the process again (spec §9.2).',
    )
    return 0
  }

  if (args.reason === null) {
    deps.io.write(`missing --reason\n${USAGE}`)
    return 1
  }
  // Checked here as well as on the server so a typo costs a round trip and not
  // an operator's confidence that the report went through.
  if (!isModerationReasonToken(args.reason)) {
    deps.io.write(
      `unknown reason token: not in the approved call table\nallowed: ${MODERATION_REASON_TOKENS.join(', ')}`,
    )
    return 1
  }

  const reported = await post(deps, '/admin/moderation', {
    reason: args.reason,
    ...(args.note === null ? {} : { note: args.note }),
  })
  if (!reported.ok) {
    deps.io.write(`moderation report failed: ${reported.error}`)
    return 1
  }
  deps.io.write(`moderation reported: ${args.reason}`)
  return 0
}

async function post(
  deps: ModerationCliDeps,
  path: string,
  body: Record<string, unknown>,
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
    const response = await fetchImpl(`${deps.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response.status >= 200 && response.status < 300
      ? { ok: true }
      : { ok: false, error: `http_${String(response.status)}` }
  } catch (error) {
    // The server is not answering. Say so plainly instead of writing a file
    // that would silently degrade the next run (see the module comment).
    return {
      ok: false,
      error: `${errorToken(error)} (server not reachable; stop the broadcast with \`npm run kill -w @vl/server -- --reason "<why>"\`)`,
    }
  }
}

interface ParsedArgs {
  readonly reason: string | null
  readonly note: string | null
  readonly clear: boolean
  readonly help: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs | { readonly error: string } {
  let reason: string | null = null
  let note: string | null = null
  let clear = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--clear') clear = true
    else if (arg === '--reason' || arg === '--note') {
      const value = argv[index + 1]
      if (value === undefined) return { error: `missing value for ${arg}` }
      if (arg === '--reason') reason = value
      else note = value
      index += 1
    } else return { error: `unknown argument: ${String(arg)}` }
  }

  return { reason, note, clear, help }
}

/**
 * A machine-stable token for a failure, unwrapping one `cause`.
 *
 * `fetch` reports a refused connection as a bare `TypeError` and hangs the
 * useful part — `ECONNREFUSED`, `ETIMEDOUT` — off `cause`. Reporting `TypeError`
 * to an operator whose broadcast is unsupervised says nothing about what to do
 * next; the code says the server is not listening (found by the end-to-end smoke
 * run, not by the unit test, which had been given an unrealistically flat
 * error).
 */
function errorToken(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error'
  const code = (error as NodeJS.ErrnoException).code
  if (code !== undefined) return code
  const cause = error.cause
  if (cause instanceof Error) {
    const causeCode = (cause as NodeJS.ErrnoException).code
    if (causeCode !== undefined) return causeCode
    return `${error.name}:${cause.name}`
  }
  return error.name
}
