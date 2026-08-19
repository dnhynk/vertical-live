import { z } from 'zod'

/**
 * V1 free commands (spec §7.1). No generative free text is ever executed.
 *
 * This enum is the set of commands that move the world, and every exhaustive
 * pass over the vocabulary — effect payloads, snapshot tallies, the input
 * arbiter, simulator scenarios — iterates it. The consent commands of BOARD D-9
 * are deliberately *not* members: they change no world state, so widening this
 * enum would silently enroll them in staging and tallying (TASK_SPECS §T20a).
 */
export const CommandNameSchema = z.enum(['FEED', 'PLAY', 'PET', 'VOTE_A', 'VOTE_B', 'VOTE_C'])
export type CommandName = z.infer<typeof CommandNameSchema>

/**
 * Opt-in identity commands (BOARD D-9, 2026-08-19). `JOIN` records consent to
 * the on-screen notice and starts storing the display name; `LEAVE` deletes the
 * consent record immediately. Both are allowlisted commands of spec §7.1 and
 * neither touches world state: no growth, no tally, no vote weight.
 *
 * They take no argument, so a chat line cannot ride along with a consent
 * decision.
 */
export const ConsentCommandNameSchema = z.enum(['JOIN', 'LEAVE'])
export type ConsentCommandName = z.infer<typeof ConsentCommandNameSchema>

/** Every allowlisted command name: the world commands plus the consent commands. */
export type AllowlistedCommandName = CommandName | ConsentCommandName

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
 * A normalized consent command (BOARD D-9). `argument` is `null` by
 * construction: `JOIN` and `LEAVE` are whole decisions, and an argument slot
 * would be a second place a chat line could try to enter.
 */
export const ConsentCommandRefSchema = z.strictObject({
  name: ConsentCommandNameSchema,
  argument: z.null(),
})
export type ConsentCommandRef = z.infer<typeof ConsentCommandRefSchema>

/**
 * What the command parser may return. The two members stay separate types on
 * purpose: everything that moves the world takes a `CommandRef`, so a consent
 * command cannot reach a world code path by assignment (TASK_SPECS §T20a).
 */
export const AnyCommandRefSchema = z.union([CommandRefSchema, ConsentCommandRefSchema])
export type AnyCommandRef = z.infer<typeof AnyCommandRefSchema>

const CONSENT_COMMAND_NAMES: ReadonlySet<string> = new Set(ConsentCommandNameSchema.options)

/** Narrows a parser result to the consent half of the allowlist. */
export function isConsentCommandRef(command: AnyCommandRef): command is ConsentCommandRef {
  return CONSENT_COMMAND_NAMES.has(command.name)
}

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
  // §7.1 lists the bare letters and no icon alias for them; none is invented here.
  VOTE_A: { ja: [], icons: [], en: ['A'], nativeReview: 'pending' },
  VOTE_B: { ja: [], icons: [], en: ['B'], nativeReview: 'pending' },
  VOTE_C: { ja: [], icons: [], en: ['C'], nativeReview: 'pending' },
}

/**
 * Consent command aliases (BOARD D-9), same shape and same rules as the table
 * above.
 *
 * `なのる` (名乗る, to give one's name) is what consent does and `なまえけす`
 * (erase my name) is what withdrawal does; the two spellings are far enough
 * apart that no typo turns one into the other, which matters when one of them
 * starts storing personal data and the other deletes it.
 *
 * Neither has an icon alias. A single emoji is the easiest thing to send by
 * accident, and these two commands are the consent boundary of spec §12.4 —
 * §7.1 gives no icon to the vote commands either, and none is invented here.
 *
 * None of these spellings is a T14 call-to-action string
 * (`ごはん`/`あそぶ`/`なでる`/`🍙`/`🎾`/`❤️`/`A`/`B`/`C`).
 */
export const CONSENT_COMMAND_ALIASES: Readonly<Record<ConsentCommandName, CommandAliasEntry>> = {
  JOIN: { ja: ['なのる'], icons: [], en: ['JOIN'], nativeReview: 'pending' },
  LEAVE: { ja: ['なまえけす'], icons: [], en: ['LEAVE'], nativeReview: 'pending' },
}

/**
 * The whole allowlist in one table, which is what the T6 parser matches a
 * message token against. Splitting the data by effect (world / consent) while
 * keeping one lookup is what lets the parser prove no spelling is ambiguous.
 */
export const ALLOWLISTED_COMMAND_ALIASES: Readonly<
  Record<AllowlistedCommandName, CommandAliasEntry>
> = {
  ...COMMAND_ALIASES,
  ...CONSENT_COMMAND_ALIASES,
}

/**
 * Port implemented by the T6 command parser and injected into the source
 * adapters. It receives the raw message text and returns a canonical command or
 * `null`. Raw text stops here: the adapters never place it in an envelope.
 *
 * The return type covers the consent commands too (BOARD D-9); a parser that
 * only produces world commands still satisfies it.
 */
export type CommandParser = (rawText: string) => AnyCommandRef | null
