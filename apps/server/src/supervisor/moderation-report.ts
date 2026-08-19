import { systemClock, type Clock } from '../clock.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import {
  authorizeAdmin,
  readTokenField,
  type AdminRequest,
  type AdminResponse,
} from './admin-auth.js'

/**
 * The human-triggered half of spec §12.3's call path (TASK_SPECS §T22).
 *
 * §12.3 names four events that "사람 호출 대상" — targeted hate or threats,
 * exposed personal data, sexual or self-harm risk, and a surge of filter
 * evasion — and Gate 0 (BOARD D-13) approved all four as safe-stop conditions.
 * Only the fourth is something a machine can observe (see
 * `moderation-heuristic.ts`); the other three are a judgement a person makes
 * while reading the actual chat in Studio. This endpoint is how that judgement
 * reaches the running supervisor.
 *
 * Two rules shape the surface:
 *
 * - **The reason is a token from the approved table, or the request is
 *   refused.** A free-text reason would arrive at `reportModerationHealth()`,
 *   never match `safeStopConditions`, and quietly turn into a warning that does
 *   not stop the broadcast — the exact failure `moderation-call-table.md` §2
 *   warns about ("문자열이 다르면 조건은 영원히 일치하지 않는다").
 * - **`note` never leaves the log.** An operator needs somewhere to write why
 *   they pressed it; a broadcast state document is not that place, and a note
 *   pasted from chat would be raw chat in an alert (§12.3).
 */

/**
 * `moderation-call-table.md` §2, approved as BOARD D-13 on 2026-08-19.
 *
 * This is the repository's copy of the call table's token column. It is *not*
 * the safe-stop list: which of these stop the run is
 * `supervisor.moderation.safeStopConditions` in `config/default.json`, because
 * that is the human approval of §12.3 and the code does not get to decide it.
 * Today the approved table sets them equal, and `config.test.ts` fails if the
 * two ever drift apart.
 */
export const MODERATION_REASON_TOKENS = [
  /** 표적 혐오·협박 (§12.3). */
  'targeted_harassment',
  /** 개인정보 노출 (§12.3). */
  'pii_exposure',
  /** 성적·자해 위험 (§12.3). */
  'sexual_or_self_harm_risk',
  /** 필터 우회 폭증 (§12.3) — the one `moderation-heuristic.ts` also reports. */
  'filter_evasion_surge',
] as const

export type ModerationReasonToken = (typeof MODERATION_REASON_TOKENS)[number]

export function isModerationReasonToken(value: string): value is ModerationReasonToken {
  return (MODERATION_REASON_TOKENS as readonly string[]).includes(value)
}

/** What the endpoint hands to the supervisor. Tokens and instants only. */
export interface ModerationReport {
  readonly source: 'http' | 'heuristic'
  readonly reason: ModerationReasonToken
  readonly at: string
}

export interface ModerationReportHandlers {
  /** `supervisor.reportModerationHealth('degraded', reason)`. */
  readonly onReport: (report: ModerationReport) => void
  /** `supervisor.reportModerationHealth('ok')`. */
  readonly onClear: (at: string) => void
}

export interface AdminModerationEndpointOptions extends ModerationReportHandlers {
  /** `server.adminToken` from the vault — the same one `/admin/kill` uses. */
  readonly token: string | null
  readonly clock?: Clock
  readonly logger?: Logger
}

/** How much of an operator's note is kept for the log line. */
const MAX_NOTE_LENGTH = 200

/**
 * `POST /admin/moderation` and `POST /admin/moderation/clear`, loopback +
 * bearer token — the same admission rules as `/admin/kill` (spec §10.2).
 */
export class AdminModerationEndpoint {
  readonly #options: AdminModerationEndpointOptions
  readonly #clock: Clock
  readonly #logger: Logger

  constructor(options: AdminModerationEndpointOptions) {
    this.#options = options
    this.#clock = options.clock ?? systemClock
    this.#logger = options.logger ?? silentLogger
  }

  /** `POST /admin/moderation` — `{ reason: "<token>", note?: string }`. */
  report(request: AdminRequest): AdminResponse {
    const refusal = authorizeAdmin(request, this.#options.token)
    if (refusal !== null) return refusal

    const reason = readTokenField(request.body, 'reason')
    if (reason === null || !isModerationReasonToken(reason)) {
      // The rejected value is not echoed: it is operator input, and a 400 that
      // repeats it back is a way for text to reach a log or a screen. What comes
      // back instead is the approved vocabulary, which is public in
      // `moderation-call-table.md` §2 and is what the caller needed to know.
      return {
        status: 400,
        body: { error: 'unknown_reason', accepted: [...MODERATION_REASON_TOKENS] },
      }
    }

    const at = this.#clock.nowUtcIso()
    // Logged, and only logged (§12.3): the note is free text, so it goes no
    // further than this process's own log — not into the alert, not into
    // `/health`, not into the world state.
    this.#logger.warn('moderation reported', {
      reason,
      at,
      note: readNote(request.body),
    })
    this.#options.onReport({ source: 'http', reason, at })
    return { status: 202, body: { accepted: true, reason, at } }
  }

  /** `POST /admin/moderation/clear` — the operator says the chat is safe again. */
  clear(request: AdminRequest): AdminResponse {
    const refusal = authorizeAdmin(request, this.#options.token)
    if (refusal !== null) return refusal

    const at = this.#clock.nowUtcIso()
    this.#logger.warn('moderation cleared', { at, note: readNote(request.body) })
    this.#options.onClear(at)
    // Clearing restores the CTA; it does not restart a run that already stopped.
    // Leaving `safe_stopped` is starting the process again (spec §9.2), and
    // saying so here is cheaper than an operator waiting for a broadcast that is
    // never coming back.
    return { status: 202, body: { accepted: true, cleared: true, at, resumesRun: false } }
  }
}

/**
 * The operator's note, bounded and stripped of control characters.
 *
 * Unlike a reason token this keeps ordinary punctuation — it is a sentence a
 * person writes, and the only place it goes is a log line on this host.
 */
function readNote(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const note = (body as Record<string, unknown>)['note']
  if (typeof note !== 'string' || note === '') return null
  const cleaned = note
    .slice(0, MAX_NOTE_LENGTH)
    .replace(/\p{Cc}|\p{Cf}/gu, ' ')
    .trim()
  return cleaned === '' ? null : cleaned
}
