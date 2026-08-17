import { z } from 'zod'

/**
 * Shared value types. Every schema in this package is built from these so the
 * privacy invariants of spec §7.3(1) and §12.3 hold structurally: nothing in the
 * contract accepts free-form human text, so an author name or a raw chat line has
 * no field it could travel in.
 */

/**
 * Absolute UTC instant, ISO 8601 with a `Z` designator (spec §10.2). Offsets are
 * rejected: persisted times are UTC, and intervals are measured with a monotonic
 * clock instead.
 */
export const IsoUtcInstantSchema = z.iso.datetime()
export type IsoUtcInstant = z.infer<typeof IsoUtcInstantSchema>

/**
 * Identifier issued by an external platform (message, broadcast and chat ids).
 * The character class excludes `:` so it cannot forge an `eventKey` separator.
 */
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export const ExternalIdSchema = z
  .string()
  .regex(EXTERNAL_ID_PATTERN, 'external id must be 1-128 chars of [A-Za-z0-9_-]')
export type ExternalId = z.infer<typeof ExternalIdSchema>

/**
 * Stable identifier owned by the world model (creature, mission, weather, …).
 * The vocabulary itself is defined by the content director in T7; the contract
 * only fixes the shape. Lower-case ids keep display strings out of state fields.
 */
export const IdentifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'identifier must be 1-64 chars of [a-z0-9_-]')
export type Identifier = z.infer<typeof IdentifierSchema>

/**
 * Dotted i18n key, e.g. `need.hungry`. The renderer resolves it against
 * `ja.json` (spec §5.3). Snapshots carry keys, never sentences, so raw chat can
 * never reach the screen through a display field (spec §12.3).
 */
export const TextKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/, 'text key must be a dotted lower-case i18n key')
export type TextKey = z.infer<typeof TextKeySchema>

/** Progress towards a goal, e.g. bond, growth or chapter completion (spec §6.3). */
export const ProgressSchema = z.strictObject({
  current: z.number().nonnegative(),
  target: z.number().positive(),
})
export type Progress = z.infer<typeof ProgressSchema>

/**
 * Normalizes a source timestamp to a canonical UTC instant.
 * Returns `null` when the value is absent or not a parsable instant, which the
 * adapters report as a validation error rather than guessing a time.
 */
export function toIsoUtcInstant(value: unknown): IsoUtcInstant | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toISOString()
}
