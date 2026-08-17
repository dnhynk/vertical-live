import { PLANNED_METHODS, type PlannedMethod } from '../scopes.js'

/**
 * Quota accounting table (`docs/tasks/TASK_SPECS.md` §T3 acceptance 3: 사용
 * 예정 메서드 전부 + 근거 URL).
 *
 * Official facts (checked 2026-08-17):
 * - "Projects that enable the YouTube Data API have a default quota allocation
 *   of 100 search.list calls, 100 videos.insert calls, and 10,000 units per day
 *   combined for all other endpoints"; quota resets at "midnight Pacific Time
 *   (PT)" — https://developers.google.com/youtube/v3/determine_quota_cost
 * - "A read operation that retrieves a list of resources … usually costs 1
 *   unit"; "A write operation that creates, updates, or deletes a resource
 *   usually costs 50 units" —
 *   https://developers.google.com/youtube/v3/getting-started
 *
 * What is *not* published: the quota calculator's cost table lists Data API
 * resources but no `liveBroadcasts`/`liveStreams`/`liveChatMessages` rows, and
 * the Live Streaming API reference pages carry no "Quota impact" line. Those
 * entries are therefore marked `documented: false` and carry the read/write
 * rule as their basis. They are provisional (BOARD A-15): Gate 2 replaces them
 * with measured `queryCost` values from the real project's quota dashboard
 * instead of anyone inventing a number.
 */

export const QUOTA_DAILY_DEFAULT_UNITS = 10_000
export const QUOTA_RESET_TIME_ZONE = 'America/Los_Angeles'

export const QUOTA_DOC_URL = 'https://developers.google.com/youtube/v3/determine_quota_cost'
export const READ_WRITE_RULE_URL = 'https://developers.google.com/youtube/v3/getting-started'

const CHECKED_ON = '2026-08-17'

export interface QuotaCostEntry {
  readonly units: number
  readonly operation: 'read' | 'write' | 'stream'
  /** true only when an official page states the cost for this exact method. */
  readonly documented: boolean
  readonly evidenceUrl: string
  readonly checkedOn: string
  readonly basis: string
}

const READ_BASIS =
  'Data API read/list rule: "A read operation that retrieves a list of resources … usually costs 1 unit" (getting-started). No per-method figure is published for the Live Streaming API.'
const WRITE_BASIS =
  'Data API write rule: "A write operation that creates, updates, or deletes a resource usually costs 50 units" (getting-started). No per-method figure is published for the Live Streaming API.'

export const QUOTA_COSTS: Readonly<Record<PlannedMethod, QuotaCostEntry>> = Object.freeze({
  'liveChatMessages.list': {
    units: 1,
    operation: 'read',
    documented: false,
    evidenceUrl: READ_WRITE_RULE_URL,
    checkedOn: CHECKED_ON,
    basis: READ_BASIS,
  },
  'liveChatMessages.streamList': {
    units: 1,
    operation: 'stream',
    documented: false,
    evidenceUrl: 'https://developers.google.com/youtube/v3/live/streaming-live-chat',
    checkedOn: CHECKED_ON,
    basis: `${READ_BASIS} Counted once per stream open (a gRPC stream replaces repeated list polls); the real cost per stream must be read off the quota dashboard in Gate 2.`,
  },
  'liveBroadcasts.list': {
    units: 1,
    operation: 'read',
    documented: false,
    evidenceUrl: READ_WRITE_RULE_URL,
    checkedOn: CHECKED_ON,
    basis: READ_BASIS,
  },
  'liveBroadcasts.insert': {
    units: 50,
    operation: 'write',
    documented: false,
    evidenceUrl: READ_WRITE_RULE_URL,
    checkedOn: CHECKED_ON,
    basis: WRITE_BASIS,
  },
  'liveBroadcasts.bind': {
    units: 50,
    operation: 'write',
    documented: false,
    evidenceUrl: READ_WRITE_RULE_URL,
    checkedOn: CHECKED_ON,
    basis: `${WRITE_BASIS} bind updates the broadcast's bound stream.`,
  },
  'liveBroadcasts.transition': {
    units: 50,
    operation: 'write',
    documented: false,
    evidenceUrl: READ_WRITE_RULE_URL,
    checkedOn: CHECKED_ON,
    basis: `${WRITE_BASIS} transition updates the broadcast's status.`,
  },
  'liveStreams.list': {
    units: 1,
    operation: 'read',
    documented: false,
    evidenceUrl: READ_WRITE_RULE_URL,
    checkedOn: CHECKED_ON,
    basis: READ_BASIS,
  },
  'liveStreams.insert': {
    units: 50,
    operation: 'write',
    documented: false,
    evidenceUrl: READ_WRITE_RULE_URL,
    checkedOn: CHECKED_ON,
    basis: WRITE_BASIS,
  },
  'videos.list': {
    units: 1,
    operation: 'read',
    documented: true,
    evidenceUrl: QUOTA_DOC_URL,
    checkedOn: CHECKED_ON,
    basis: 'Quota calculator table lists videos.list = 1 unit.',
  },
})

export function quotaCostOf(method: PlannedMethod): number {
  return QUOTA_COSTS[method].units
}

/** Methods whose cost is derived rather than published — Gate 2 must confirm. */
export function provisionalQuotaMethods(): PlannedMethod[] {
  return PLANNED_METHODS.filter((method) => !QUOTA_COSTS[method].documented)
}
