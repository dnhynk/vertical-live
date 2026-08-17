import { CommandRefSchema, type CommandName } from '@vl/contract'

import { matchAlias } from './aliases.js'
import { moderate } from './moderation.js'
import { normalizeText, tokenize } from './normalize.js'
import type { ParseContext, ParseResult, RejectionReason } from './types.js'

/**
 * The command parser of spec §7.1 and §7.3(1): a pure function from a chat
 * message to a canonical command or a rejection code. No natural-language model
 * is involved and no free text is executed — the allowlist and the explicit
 * alias table are the entire vocabulary.
 *
 * Checks run in a fixed order so one message always yields one code:
 *
 *  1. `too_long` — a length guard before any Unicode work is done.
 *  2. `empty` — nothing survived normalization.
 *  3. moderation — link, personal data, banned term (spec §12.3 discards these
 *     "regardless of any command effect", so they outrank the shape rules).
 *  4. `no_command` — the first token is not in the allowlist.
 *  5. `extraneous_text` / `invalid_argument` — the accepted shape is exactly
 *     `command` or `command <short word>`, and the word may not itself be a
 *     command. The word is letters and digits only: the contract's charset also
 *     allows `-` and `_`, but a separator inside an argument is how a host or
 *     an address gets spelled as one token (R-T6-1 blocker 1), so the parser is
 *     deliberately stricter than the schema it still validates against.
 *  6. `vote_disabled` — `VOTE_A/B/C` needs both an open identity gate and an
 *     open vote window (spec §6.4, §7.1, BOARD A-1/A-9).
 *
 * `commandLike` is computed at step 4 regardless of the outcome, because it is
 * the denominator of the "명령 성공" metric in spec §14.1.
 */

export interface ParserLimits {
  /** Characters of raw input accepted before the message is dropped unread. */
  readonly maxRawLength: number
}

const VOTE_COMMANDS: ReadonlySet<CommandName> = new Set(['VOTE_A', 'VOTE_B', 'VOTE_C'])

/**
 * A command argument is one plain word. `normalizeText` has already folded case,
 * so the range is lower-case only, and the length matches the contract's bound
 * (`CommandRefSchema`), which is still applied afterwards.
 */
const ARGUMENT_WORD = /^[a-z0-9]{1,32}$/

function reject(reason: RejectionReason, commandLike: boolean): ParseResult {
  return { status: 'rejected', reason, commandLike }
}

export function parseMessage(
  rawText: string,
  context: ParseContext,
  limits: ParserLimits,
): ParseResult {
  if (rawText.length > limits.maxRawLength) {
    return reject('too_long', false)
  }

  const text = normalizeText(rawText)
  if (text.normalized.length === 0) {
    return reject('empty', false)
  }

  const tokens = tokenize(text.normalized)
  const first = tokens[0]
  if (first === undefined) {
    return reject('empty', false)
  }
  const name = matchAlias(first)
  const commandLike = name !== null

  const moderationReason = moderate(text)
  if (moderationReason !== null) {
    return reject(moderationReason, commandLike)
  }

  if (name === null) {
    return reject('no_command', false)
  }
  const argument = tokens[1] ?? null
  // A second command is not an argument: `feed play` is two intents in one
  // message, and picking one of them would be guessing at meaning.
  if (tokens.length > 2 || (argument !== null && matchAlias(argument) !== null)) {
    return reject('extraneous_text', true)
  }

  if (argument !== null && !ARGUMENT_WORD.test(argument)) {
    return reject('invalid_argument', true)
  }
  const command = CommandRefSchema.safeParse({ name, argument })
  if (!command.success) {
    return reject('invalid_argument', true)
  }

  if (VOTE_COMMANDS.has(name) && !(context.identityGateOpen && context.voteWindowOpen)) {
    return reject('vote_disabled', true)
  }

  return { status: 'accepted', command: command.data, commandLike: true }
}
