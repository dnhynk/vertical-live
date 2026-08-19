import type { CommandRef, ConsentCommandRef } from '@vl/contract'

/**
 * Why a message did not become a command. Spec §7.3(1) and §12.3 allow the
 * *code* to be recorded and nothing else: no rejection value in this package
 * carries the message, a fragment of it, its length or the term that matched.
 */
export type RejectionReason =
  /** Longer than `input.maxRawLength`; not normalized at all. */
  | 'too_long'
  /** Nothing left after normalization (only invisibles, marks or spaces). */
  | 'empty'
  /** Link or link-like host, including obfuscated spellings (spec §12.3). */
  | 'url'
  /** Contact or identifying data: address, handle, long number (spec §12.3). */
  | 'personal_data'
  | 'banned_hate'
  | 'banned_sexual'
  | 'banned_self_harm'
  | 'banned_violence'
  | 'banned_ads_scam'
  /** Did not start with an allowlisted command or alias (spec §7.1). */
  | 'no_command'
  /** Command matched but was followed by more than one short argument. */
  | 'extraneous_text'
  /** The single trailing token is not a `CommandRef.argument` token. */
  | 'invalid_argument'
  /** `VOTE_A/B/C` outside an open vote window or with the identity gate closed. */
  | 'vote_disabled'
  /** `JOIN`/`LEAVE` while the consent gate is closed (BOARD A-1, D-9). */
  | 'consent_disabled'

export const REJECTION_REASONS: readonly RejectionReason[] = [
  'too_long',
  'empty',
  'url',
  'personal_data',
  'banned_hate',
  'banned_sexual',
  'banned_self_harm',
  'banned_violence',
  'banned_ads_scam',
  'no_command',
  'extraneous_text',
  'invalid_argument',
  'vote_disabled',
  'consent_disabled',
]

export interface ParsedCommand {
  readonly status: 'accepted'
  readonly command: CommandRef
  /** Always true for an accepted message; kept so both arms share the field. */
  readonly commandLike: true
}

/**
 * An accepted consent command (BOARD D-9). It is a **separate status** from
 * `accepted` on purpose: everything that moves the world switches on
 * `status === 'accepted'`, so a `JOIN` cannot reach a world code path — not the
 * arbiter, not a tally, not an effect (TASK_SPECS §T20a, §T20b).
 */
export interface ParsedConsentCommand {
  readonly status: 'accepted_consent'
  readonly consentCommand: ConsentCommandRef
  readonly commandLike: true
}

export interface Rejection {
  readonly status: 'rejected'
  readonly reason: RejectionReason
  /**
   * Whether the message *looked* like a command — its first token matched the
   * allowlist — independently of why it was rejected. This is the denominator
   * of the "명령 성공" metric (spec §14.1) and is a boolean, not text.
   */
  readonly commandLike: boolean
}

export type ParseResult = ParsedCommand | ParsedConsentCommand | Rejection

/**
 * State the parser needs but does not own. Both flags come from the world
 * state, so the same message parses differently at different times and the
 * parser itself stays a pure function of `(text, context)`.
 */
export interface ParseContext {
  /**
   * Identity feature gate (spec §6.4, §7.4). BOARD A-1 kept it closed and D-9
   * redefined what "open" means: consent mode, in which a viewer who sent
   * `JOIN` is attributable and nobody else is. While it is closed there is no
   * per-user attribution, so branch voting is off and the consent commands
   * themselves are refused — accepting a `JOIN` that stores nothing would be a
   * promise the closed configuration cannot keep.
   */
  readonly identityGateOpen: boolean
  /** Whether a choice window is currently open (spec §6.4, §7.1). */
  readonly voteWindowOpen: boolean
}
