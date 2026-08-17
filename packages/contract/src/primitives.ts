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
 * ISO 8601 / RFC 3339 date-time with a mandatory time and time zone, which is
 * what [S3] `publishedAt` and [S4] `published_at` are defined to be. A date
 * without a time, a value without a zone and any locale-specific spelling are
 * outside the format and must not be guessed at.
 */
const ISO_8601_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/

/**
 * Normalizes a source timestamp to a canonical UTC instant.
 *
 * `Date.parse` is not an ISO 8601 validator — it also accepts `"0"`,
 * `"08/17/2026"` and date-only strings, and it silently rolls impossible dates
 * over (`2026-02-30` → `2026-03-02`) — so the format is checked explicitly and
 * every component is verified to survive the round trip. Returns `null` when
 * the value is absent or not an ISO 8601 instant; the adapters report that as
 * `MALFORMED_PUBLISHED_AT` rather than inventing a time.
 */
export function toIsoUtcInstant(value: unknown): IsoUtcInstant | null {
  if (typeof value !== 'string') return null
  const match = ISO_8601_DATETIME.exec(value)
  if (match === null) return null

  const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] = match
  const millis = fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'))
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millis,
  )
  // `Date.UTC` rolls out-of-range components over instead of failing, so the
  // round trip is what rejects month 13, February 30 or hour 25. It also maps
  // a two-digit year onto 19xx, which is why years before 0100 do not survive
  // it — no platform timestamp is in that range.
  const instant = new Date(utc)
  if (
    instant.getUTCFullYear() !== Number(year) ||
    instant.getUTCMonth() !== Number(month) - 1 ||
    instant.getUTCDate() !== Number(day) ||
    instant.getUTCHours() !== Number(hour) ||
    instant.getUTCMinutes() !== Number(minute) ||
    instant.getUTCSeconds() !== Number(second)
  ) {
    return null
  }

  if (sign === undefined || offsetHour === undefined || offsetMinute === undefined) {
    return instant.toISOString()
  }
  if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null
  const offsetMillis = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000
  return new Date(sign === '-' ? utc + offsetMillis : utc - offsetMillis).toISOString()
}
