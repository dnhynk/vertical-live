/**
 * The identity a `liveBroadcasts.insert` reconcile matches on.
 *
 * `liveBroadcasts.insert` has no idempotency key and the API exposes no custom
 * metadata field, so after an uncertain insert the only way to recognise *our own*
 * resource in a `list` response is a string we put there ourselves. Review round 2
 * (B1) showed why a timestamp is not enough: matching `snippet.scheduledStartTime`
 * alone adopted an unrelated broadcast scheduled for the same instant and orphaned
 * the one the insert had actually created — which is not a `list/get` reconcile at
 * all (spec §9.1).
 *
 * Why `snippet.description`:
 *
 * - it is writable on insert ("Writable/Optional: `snippet.description`",
 *   https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert) and is
 *   part of the `snippet` part returned by `list`
 *   (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts), so it can be
 *   written before the call and read back after one (both checked 2026-08-17);
 * - it has room: the insert error table caps it at 5,000 characters
 *   (`invalidValue/invalidDescription`), against 1–100 for `snippet.title`;
 * - `snippet.title` was rejected as the carrier because it is the broadcast's
 *   headline on the watch page and in the vertical feed — a machine id does not
 *   belong there.
 *
 * The marker is an obvious synthetic attempt id, never anything about a viewer, so
 * putting it on a (by default private) broadcast carries no personal data (§12.4).
 */

/** Stable prefix. Changing it is a migration concern: see `attemptMarkerOf`. */
export const ATTEMPT_MARKER_PREFIX = 'vl-attempt:'

/**
 * The documented description limit for a broadcast
 * (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert:
 * `invalidDescription` — "Description exceeds 5000 characters", checked 2026-08-17).
 */
export const BROADCAST_DESCRIPTION_MAX_LENGTH = 5000

/**
 * The marker for one attempt. Derived from the attempt id, and then **persisted**
 * with the row (`broadcast_resources.attempt_marker`) rather than recomputed at
 * reconcile time: a resumed process must compare against the string that was
 * actually sent, not against whatever this constant means in the build that happens
 * to be running after a restart.
 */
export function attemptMarkerOf(attemptId: string): string {
  return `${ATTEMPT_MARKER_PREFIX}${attemptId}`
}

/**
 * The description to send: the operator's text with the marker as its last line.
 * The operator's text is what gets truncated if the two together exceed the limit —
 * a description that lost its marker would be an unreconcilable broadcast.
 */
export function describeWithMarker(description: string, marker: string): string {
  const suffix = description === '' ? marker : `\n\n${marker}`
  const room = BROADCAST_DESCRIPTION_MAX_LENGTH - suffix.length
  if (room < 0) {
    throw new Error(
      `attempt marker ${marker} does not fit in ${String(BROADCAST_DESCRIPTION_MAX_LENGTH)} characters`,
    )
  }
  return `${description.slice(0, room)}${suffix}`
}

/**
 * The description with the marker taken out again (BOARD A-18), leaving the operator's
 * text as YouTube currently holds it. The separator this module added comes out with
 * it, and a description that was only ever the marker becomes empty.
 */
export function withoutAttemptMarker(description: string | null, marker: string): string {
  if (description === null) {
    return ''
  }
  return description
    .split(
      `

${marker}`,
    )
    .join('')
    .split(marker)
    .join('')
    .trimEnd()
}

/**
 * Whether a listed broadcast carries this attempt's marker. A substring test, not an
 * equality one: the operator's description travels with it, and a platform that
 * appended anything of its own must not make our own resource unrecognisable.
 */
export function carriesAttemptMarker(description: string | null, marker: string): boolean {
  return description !== null && description.includes(marker)
}
