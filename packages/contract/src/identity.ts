import { z } from 'zod'

/**
 * Consented viewer identity (BOARD D-9, 2026-08-19).
 *
 * Gate 0 §1.3 chose option (B): only a viewer who opted in with the `JOIN`
 * command — after the on-screen notice — has a name stored and shown, `LEAVE`
 * deletes it immediately, and everyone else stays exactly as anonymous as they
 * were while the gate was closed (spec §7.4, §12.4; BOARD A-1, partially
 * reversed by D-9). `actor` is therefore `null` by default and this shape is
 * the *only* thing it can be instead.
 *
 * The raw `channelId` is not part of this contract at all. The server issues an
 * opaque `channelRef` for the consent record it stores (T20b) and only that
 * reference travels, so a channel id cannot leak into a renderer, a fixture or
 * a log through an event or an effect.
 */

/**
 * Opaque reference to a consent record, issued by the server (T20b).
 *
 * The spelling is deliberately one a YouTube channel id cannot have: a channel
 * id is `UC` followed by 22 mixed-case base64url characters, while this is a
 * `ref_` prefix and 32 lower-case hex digits (128 random bits). Nothing derived
 * from a channel id — including a hash rendered in upper case or in base64url —
 * fits the pattern by accident, which is what makes "no channel id anywhere in
 * the contract" a structural property rather than a review habit
 * (TASK_SPECS §T20a acceptance 1).
 */
export const CHANNEL_REF_PATTERN = /^ref_[0-9a-f]{32}$/

export const ChannelRefSchema = z
  .string()
  .regex(CHANNEL_REF_PATTERN, 'channel ref must be ref_ followed by 32 lower-case hex digits')
export type ChannelRef = z.infer<typeof ChannelRefSchema>

/**
 * Longest display name the contract will carry.
 *
 * [S3] documents no limit for `authorDetails.displayName`
 * (https://developers.google.com/youtube/v3/live/docs/liveChatMessages, checked
 * 2026-08-19), and the only documented channel-title limit is the write-side
 * `brandingSettings.channel.title` maximum of 30 characters
 * (https://developers.google.com/youtube/v3/docs/channels, checked 2026-08-19).
 * The bound here is above that documented maximum so a compliant name is never
 * rejected, and finite so the field cannot hold a blob. It is a storage bound,
 * not a display bound: how many characters the screen shows is T20c's decision.
 */
export const DISPLAY_NAME_MAX_LENGTH = 100

/**
 * A consented viewer's display name, as delivered by `authorDetails`.
 *
 * Control characters and line separators are excluded so a name can never carry
 * a second line or a terminal escape onto the screen or into a log (spec
 * §12.3). Format characters are *not* excluded: emoji sequences join with
 * U+200D and a real name may contain one. Chat text has no path into this field
 * — the adapters parse a message into a command and drop the text (spec
 * §7.3(1)) — so this bounds an identity value, it does not sanitize prose.
 */
export const DisplayNameSchema = z
  .string()
  .regex(
    new RegExp(`^[^\\p{Cc}\\p{Zl}\\p{Zp}]{1,${String(DISPLAY_NAME_MAX_LENGTH)}}$`, 'u'),
    `display name must be 1-${String(DISPLAY_NAME_MAX_LENGTH)} characters with no control character or line separator`,
  )
export type DisplayName = z.infer<typeof DisplayNameSchema>

/**
 * The one non-null shape of `actor`. `kind` is a literal rather than an enum: a
 * second kind would be a second consent basis, and D-9 approved exactly one.
 */
export const ConsentedActorSchema = z.strictObject({
  kind: z.literal('consented'),
  displayName: DisplayNameSchema,
  channelRef: ChannelRefSchema,
})
export type ConsentedActor = z.infer<typeof ConsentedActorSchema>

/**
 * `null` for everyone who has not opted in — which is every viewer until they
 * send `JOIN`, and every viewer again after `LEAVE` (BOARD D-9).
 */
export const ActorSchema = ConsentedActorSchema.nullable()
export type Actor = z.infer<typeof ActorSchema>
