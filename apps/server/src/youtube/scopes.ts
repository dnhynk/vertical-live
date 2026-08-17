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
  'liveBroadcasts.update',
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
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList',
    checkedOn: CHECKED_ON,
    verified: false,
    note: 'UNVERIFIABLE from official sources on 2026-08-17, not merely unchecked: the streamList reference page has no "Authorization" section at all (headings: Demo, Request, Parameters, Request body, Response, Properties, Errors), the REST discovery document has no streamList method because the service is gRPC, and the streaming guide shows only `authorization: Bearer TOKEN` without naming a scope. The listed scopes are those of liveChatMessages.list, the REST method this streams; they are an inference, not documentation. T9 must confirm against a real call before relying on it.',
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
  'liveBroadcasts.update': {
    acceptedScopes: [SCOPE_YOUTUBE, SCOPE_YOUTUBE_FORCE_SSL],
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/update',
    checkedOn: CHECKED_ON,
    verified: true,
    note: 'Added by T10 (BOARD A-18): the attempt marker is removed from snippet.description before any public exposure, and the configured privacy is applied by the same method.',
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
 * Least-privilege comparison (review round 1, B3). Official scope descriptions,
 * quoted from https://developers.google.com/youtube/v3/guides/auth/installed-apps
 * (checked 2026-08-17; the general scope index at
 * https://developers.google.com/identity/protocols/oauth2/scopes carries the
 * same table but could not be read past its Google Chat section in this pass):
 *
 * | scope                | official description                                                              |
 * |----------------------|-----------------------------------------------------------------------------------|
 * | `youtube`            | "Manage your YouTube account"                                                     |
 * | `youtube.force-ssl`  | "See, edit, and permanently delete your YouTube videos, ratings, comments and captions" |
 * | `youtube.readonly`   | "View your YouTube account"                                                       |
 * | `youtube.upload`     | "Manage your YouTube videos"                                                      |
 *
 * What the method evidence actually shows: **two** single scopes cover every
 * verified method — `youtube` and `youtube.force-ssl` (see
 * `sufficientSingleScopes()`, which is asserted in the tests). The earlier claim
 * that `force-ssl` was the *only* such scope was wrong and is withdrawn.
 * `youtube.readonly` is genuinely insufficient: it is not accepted by
 * `liveBroadcasts.insert`/`bind`/`transition` or `liveStreams.insert`.
 *
 * Why `youtube.force-ssl` is chosen between the two, given that neither is
 * documented as a subset of the other:
 * 1. its description bounds the objects it reaches (videos, ratings, comments,
 *    captions), while `youtube` is unbounded account management;
 * 2. it additionally requires every call to use SSL — a strictly stronger
 *    constraint than `youtube`, never a weaker one.
 * This is a recorded judgment with its basis, not a proof of strict minimality:
 * Google publishes no per-scope method matrix. Revisit if one appears.
 */
export const REQUIRED_SCOPES: readonly string[] = Object.freeze([SCOPE_YOUTUBE_FORCE_SSL])

/** Scopes that on their own authorize every verified planned method. */
export function sufficientSingleScopes(): string[] {
  const candidates = new Set<string>()
  for (const method of PLANNED_METHODS) {
    const entry = METHOD_SCOPES[method]
    if (!entry.verified) continue
    for (const scope of entry.acceptedScopes) candidates.add(scope)
  }
  return [...candidates].filter((scope) => checkScopeCoverage([scope]).sufficient).sort()
}

/** Planned methods whose accepted scopes no official source states. */
export function unverifiedScopeMethods(): PlannedMethod[] {
  return PLANNED_METHODS.filter((method) => !METHOD_SCOPES[method].verified)
}

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
