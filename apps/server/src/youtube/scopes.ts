/**
 * OAuth scopes for the YouTube methods this product calls (spec §10.2: "OAuth은
 * 필요한 최소 scope만 요청한다").
 *
 * Every entry below records which scopes the method accepts and where that was
 * read. Sources (checked 2026-08-17), see `docs/tasks/TASK-T3-auth-vault.md`:
 * - discovery document `https://youtube.googleapis.com/$discovery/rest?version=v3`
 *   (machine-readable `scopes` array per method)
 * - the per-method reference pages under
 *   `https://developers.google.com/youtube/v3/live/docs/...` ("This request
 *   requires authorization with at least one of the following scopes")
 */

export const SCOPE_YOUTUBE = 'https://www.googleapis.com/auth/youtube'
export const SCOPE_YOUTUBE_FORCE_SSL = 'https://www.googleapis.com/auth/youtube.force-ssl'
export const SCOPE_YOUTUBE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly'

/** API methods T9/T10 will call. Also the key space of the quota cost table. */
export const PLANNED_METHODS = [
  'liveChatMessages.list',
  'liveChatMessages.streamList',
  'liveBroadcasts.list',
  'liveBroadcasts.insert',
  'liveBroadcasts.bind',
  'liveBroadcasts.transition',
  'liveStreams.list',
  'liveStreams.insert',
  'videos.list',
] as const

export type PlannedMethod = (typeof PLANNED_METHODS)[number]

export interface MethodScopeEntry {
  /** Scopes the method accepts; holding any one of them authorizes the call. */
  readonly acceptedScopes: readonly string[]
  readonly evidenceUrl: string
  /** ISO date the evidence was read. */
  readonly checkedOn: string
  /**
   * false when the accepted-scope list could not be read from an official page
   * in this pass. Such a method is excluded from the minimal-scope proof and
   * must be confirmed by the task that first calls it.
   */
  readonly verified: boolean
  readonly note?: string
}

const DISCOVERY_URL = 'https://youtube.googleapis.com/$discovery/rest?version=v3'
const CHECKED_ON = '2026-08-17'

export const METHOD_SCOPES: Readonly<Record<PlannedMethod, MethodScopeEntry>> = Object.freeze({
  'liveChatMessages.list': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL, SCOPE_YOUTUBE_READONLY],
    evidenceUrl: DISCOVERY_URL,
    checkedOn: CHECKED_ON,
    verified: true,
  },
  'liveChatMessages.streamList': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL, SCOPE_YOUTUBE_READONLY],
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/streaming-live-chat',
    checkedOn: CHECKED_ON,
    verified: false,
    note: 'gRPC streaming variant of liveChatMessages.list; the guide shows an OAuth bearer token but publishes no scope list. Confirm in T9 before the first real call.',
  },
  'liveBroadcasts.list': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL, SCOPE_YOUTUBE_READONLY],
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list',
    checkedOn: CHECKED_ON,
    verified: true,
  },
  'liveBroadcasts.insert': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL],
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert',
    checkedOn: CHECKED_ON,
    verified: true,
  },
  'liveBroadcasts.bind': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL],
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind',
    checkedOn: CHECKED_ON,
    verified: true,
  },
  'liveBroadcasts.transition': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL],
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition',
    checkedOn: CHECKED_ON,
    verified: true,
  },
  'liveStreams.list': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL, SCOPE_YOUTUBE_READONLY],
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/docs/liveStreams/list',
    checkedOn: CHECKED_ON,
    verified: true,
  },
  'liveStreams.insert': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL],
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/docs/liveStreams/insert',
    checkedOn: CHECKED_ON,
    verified: true,
  },
  'videos.list': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL, SCOPE_YOUTUBE_READONLY],
    evidenceUrl: 'https://developers.google.com/youtube/v3/docs/videos/list',
    checkedOn: CHECKED_ON,
    verified: false,
    note: 'Needed to read liveStreamingDetails.activeLiveChatId. The Authorization block could not be read from the reference page in this pass; confirm in T9.',
  },
})

/**
 * The scope set the login CLI requests. One scope: `youtube.force-ssl` is the
 * only single scope accepted by every verified method above, including the
 * write ones (insert/bind/transition), so requesting anything else would either
 * be insufficient (`youtube.readonly`) or a second grant on top of it.
 */
export const REQUIRED_SCOPES: readonly string[] = Object.freeze([SCOPE_YOUTUBE_FORCE_SSL])

export interface ScopeCoverage {
  readonly sufficient: boolean
  /** Verified methods no granted scope covers. */
  readonly uncoveredMethods: readonly PlannedMethod[]
  /** Granted scopes not needed by any planned method. */
  readonly extraneousScopes: readonly string[]
}

/**
 * Checks a granted scope list (the `scope` field Google returns with a token)
 * against the planned methods. Unverified methods are ignored: their accepted
 * scopes are not established, so counting them would turn a guess into a gate.
 */
export function checkScopeCoverage(grantedScopes: readonly string[]): ScopeCoverage {
  const granted = new Set(grantedScopes)
  const uncoveredMethods: PlannedMethod[] = []
  const usefulScopes = new Set<string>()

  for (const method of PLANNED_METHODS) {
    const entry = METHOD_SCOPES[method]
    if (!entry.verified) continue
    const covering = entry.acceptedScopes.filter((scope) => granted.has(scope))
    if (covering.length === 0) {
      uncoveredMethods.push(method)
      continue
    }
    for (const scope of covering) usefulScopes.add(scope)
  }

  return {
    sufficient: uncoveredMethods.length === 0,
    uncoveredMethods,
    extraneousScopes: [...granted].filter((scope) => !usefulScopes.has(scope)),
  }
}

/** Parses the space-delimited `scope` value Google returns with a token. */
export function parseScopeString(scope: string | undefined | null): readonly string[] {
  if (scope === undefined || scope === null) return []
  return scope.split(/\s+/).filter((entry) => entry !== '')
}
