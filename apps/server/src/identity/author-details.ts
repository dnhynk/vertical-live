import { DisplayNameSchema, EXTERNAL_ID_PATTERN, type SourceShape } from '@vl/contract'

/**
 * The two readers for `authorDetails`, one per source shape (spec §7.2: "gRPC
 * proto와 REST resource의 필드명을 섞지 않고").
 *
 * This is the *only* place in the server that touches an author field, and it
 * hands the two values straight back to the caller — it does not store them, log
 * them or put them in an error message. Everything downstream either turns them
 * into a consent row (`viewer_consent`) or drops them on the floor within the
 * same call (BOARD D-9, spec §7.4).
 *
 * The part is requested only while the consent gate is open
 * (`youtube/chat/config.ts`), so in the closed configuration these functions
 * find nothing to read even if they are called.
 */

/** What one message says about its author, before any consent decision. */
export interface AuthorIdentity {
  /** Raw YouTube channel id. Never leaves memory except into `viewer_consent`. */
  readonly channelId: string
  readonly displayName: string
}

/**
 * gRPC `streamList` spelling: `author_details.channel_id` / `.display_name`
 * ([S4] inline proto, snake_case with `keepCase: true`).
 */
export function readGrpcAuthorIdentity(item: unknown): AuthorIdentity | null {
  const details = readRecord(item, 'author_details')
  if (details === null) return null
  return toIdentity(details['channel_id'], details['display_name'])
}

/**
 * REST `liveChatMessages.list` spelling: `authorDetails.channelId` /
 * `.displayName` ([S3], camelCase).
 */
export function readRestAuthorIdentity(item: unknown): AuthorIdentity | null {
  const details = readRecord(item, 'authorDetails')
  if (details === null) return null
  return toIdentity(details['channelId'], details['displayName'])
}

/**
 * Picks the reader for a shape. `simulator` has no author part at all — the
 * simulator is forbidden from inventing participation (spec §2.6) — so it reads
 * nothing rather than sharing one of the two API vocabularies.
 */
export function readAuthorIdentity(item: unknown, shape: SourceShape): AuthorIdentity | null {
  if (shape === 'grpc') return readGrpcAuthorIdentity(item)
  if (shape === 'rest') return readRestAuthorIdentity(item)
  return null
}

function readRecord(item: unknown, key: string): Record<string, unknown> | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
  const value = (item as Record<string, unknown>)[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Both values must be usable or neither is: a consent row with half an identity
 * could not be shown and could not be found again for deletion.
 *
 * `channelId` is held to the same external-id charset the rest of the ingest
 * path uses, and `displayName` to the contract's `DisplayNameSchema` (bounded
 * length, no control character or line separator), so nothing that reaches the
 * database could carry a second line into a log or onto the screen (§12.3).
 */
function toIdentity(channelId: unknown, displayName: unknown): AuthorIdentity | null {
  if (typeof channelId !== 'string' || !EXTERNAL_ID_PATTERN.test(channelId)) return null
  const name = DisplayNameSchema.safeParse(displayName)
  if (!name.success) return null
  return { channelId, displayName: name.data }
}
