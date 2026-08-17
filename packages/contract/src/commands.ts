import { z } from 'zod'

/** V1 free commands (spec §7.1). No generative free text is ever executed. */
export const CommandNameSchema = z.enum(['FEED', 'PLAY', 'PET', 'VOTE_A', 'VOTE_B', 'VOTE_C'])
export type CommandName = z.infer<typeof CommandNameSchema>

/**
 * A normalized command. `argument` is restricted to a short token charset so a
 * chat line can never be smuggled through it (spec §7.3(1)).
 */
export const CommandRefSchema = z.strictObject({
  name: CommandNameSchema,
  argument: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/, 'command argument must be a short token')
    .nullable(),
})
export type CommandRef = z.infer<typeof CommandRefSchema>

/**
 * Alias table for spec §7.1: Japanese wording, icon and short English alias all
 * normalize to the same canonical command. The canonical name itself is always
 * accepted. `nativeReview` stays `pending` until a Japanese native speaker signs
 * off (spec §5.3, Gate 3) — no entry may claim review before then.
 *
 * This is data only. Unicode normalization, allowlisting and banned-word
 * filtering are implemented by the command parser in T6.
 */
export interface CommandAliasEntry {
  readonly ja: readonly string[]
  readonly icons: readonly string[]
  readonly en: readonly string[]
  readonly nativeReview: 'pending'
}

export const COMMAND_ALIASES: Readonly<Record<CommandName, CommandAliasEntry>> = {
  FEED: { ja: ['ごはん'], icons: ['🍙'], en: ['FEED'], nativeReview: 'pending' },
  PLAY: { ja: ['あそぶ'], icons: ['🎾'], en: ['PLAY'], nativeReview: 'pending' },
  PET: { ja: ['なでる'], icons: ['❤️'], en: ['PET'], nativeReview: 'pending' },
  // Vote commands only exist inside an open choice window (spec §7.1) and are
  // only user-attributable when the identity gate is open (spec §6.4, BOARD A-1).
  VOTE_A: { ja: ['A'], icons: ['🅰️'], en: ['A'], nativeReview: 'pending' },
  VOTE_B: { ja: ['B'], icons: ['🅱️'], en: ['B'], nativeReview: 'pending' },
  VOTE_C: { ja: ['C'], icons: ['🇨'], en: ['C'], nativeReview: 'pending' },
}

/**
 * Port implemented by the T6 command parser and injected into the source
 * adapters. It receives the raw message text and returns a canonical command or
 * `null`. Raw text stops here: the adapters never place it in an envelope.
 */
export type CommandParser = (rawText: string) => CommandRef | null
