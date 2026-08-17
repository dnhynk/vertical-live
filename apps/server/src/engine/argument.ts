import type { IngestEnvelope } from '@vl/contract'

import { CHAPTER_DEFINITIONS } from '../world/content/chapters.js'

/**
 * The storage boundary for `command.argument` (TASK_SPECS §T8, R-T8-1 blocker 4).
 *
 * T6 already guarantees an argument is a short token and never raw chat text,
 * but a *token* the world will never recognize still has no business being
 * written to the append-only inbox: it is caller-chosen content that outlives the
 * message and is subject to §12.4 retention like everything else in the row.
 *
 * So the rule is split in two:
 *
 * - **here, before the write** — the argument survives only if it names a choice
 *   the content can ever offer. This vocabulary is static, which is exactly why
 *   it can be applied at ingest time, when no choice window may be open yet.
 * - **in the writer, at processing time** — the argument reaches the world only
 *   if the *currently open* window expects it (`StateEngine`).
 *
 * The rejected token is dropped, not stored and not logged (spec §12.3); the
 * envelope keeps its `valid` status because the message itself was a valid
 * command, and the writer records the drop in the processing result.
 */

/** Every `choiceId` the content director can ever put in a choice window. */
export const STORABLE_COMMAND_ARGUMENTS: ReadonlySet<string> = new Set(
  CHAPTER_DEFINITIONS.flatMap((chapter) => chapter.options.map((option) => option.choiceId)),
)

export interface SanitizedEnvelope {
  readonly envelope: IngestEnvelope
  /** True when an argument was dropped, so the caller can count it. */
  readonly dropped: boolean
}

export function sanitizeEnvelopeArgument(envelope: IngestEnvelope): SanitizedEnvelope {
  if (envelope.validationStatus !== 'valid') return { envelope, dropped: false }
  const command = envelope.command
  if (command === null || command.argument === null) return { envelope, dropped: false }
  if (STORABLE_COMMAND_ARGUMENTS.has(command.argument)) return { envelope, dropped: false }
  return {
    envelope: { ...envelope, command: { name: command.name, argument: null } },
    dropped: true,
  }
}

export function sanitizeEnvelopeArguments(envelopes: readonly IngestEnvelope[]): {
  readonly envelopes: IngestEnvelope[]
  readonly droppedCount: number
} {
  const sanitized = envelopes.map(sanitizeEnvelopeArgument)
  return {
    envelopes: sanitized.map((entry) => entry.envelope),
    droppedCount: sanitized.filter((entry) => entry.dropped).length,
  }
}
