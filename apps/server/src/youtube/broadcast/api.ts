import type { Clock } from '../../clock.js'
import { SecretRedactor, silentLogger, type Logger } from '../../secrets/redaction.js'
import type { PlannedMethod } from '../scopes.js'
import { classifyYouTubeApiError, type ApiErrorClassification } from '../quota/classify.js'
import type { QuotaTracker } from '../quota/tracker.js'
import type {
  BroadcastLatencyPreference,
  BroadcastPrivacyStatus,
  StreamFrameRate,
  StreamIngestionType,
  StreamResolution,
} from './config.js'

/**
 * The six Live Streaming API methods the broadcast lifecycle calls, over plain
 * `fetch` (spec §9.1).
 *
 * Why not `googleapis` (which T3 declared for the Data API): this task's core
 * requirement is that a mutating call whose result is *unknown* is reconciled and
 * never blindly retried (spec §9.1). That makes the retry policy part of the
 * product, so it cannot live inside a client whose own retry/timeout behaviour is
 * configuration we do not own. Owning the request also means:
 *
 * - `outcome` below is decided where the failure happens: a 4xx definitely did not
 *   apply, a timeout/socket error/5xx may have;
 * - the response is parsed field by field, so `cdn.ingestionInfo.streamName` — the
 *   stream key — is handed to the vault and dropped, and never reaches a return
 *   value, a log line, the database or an error message (spec §10.2, BOARD A-16);
 * - no module-load cost is added to every server start (T3 measured 5,194 ms for
 *   the `googleapis` barrel against 4 ms for `google-auth-library`).
 *
 * Nothing here decides what a failure *means* for the broadcast: `lifecycle.ts`
 * does, and T12 aggregates.
 */

/** https://developers.google.com/youtube/v3 (checked 2026-08-17). */
export const YOUTUBE_API_BASE_URL = 'https://www.googleapis.com/youtube/v3'

/** What is known about whether a failed call took effect at YouTube. */
export type ApiCallOutcome =
  /** The request never left this process (quota gate, revoked grant). */
  | 'not_attempted'
  /** YouTube answered and refused. Nothing was created or changed. */
  | 'rejected'
  /** Timeout, transport failure or 5xx: it may or may not have been applied. */
  | 'uncertain'

export class YouTubeApiCallError extends Error {
  readonly method: PlannedMethod
  readonly outcome: ApiCallOutcome
  readonly classification: ApiErrorClassification

  constructor(
    method: PlannedMethod,
    outcome: ApiCallOutcome,
    classification: ApiErrorClassification,
    detail?: string,
  ) {
    super(
      `${method} ${outcome}: ${classification.kind}${
        classification.reason === undefined ? '' : ` (${classification.reason})`
      }${detail === undefined ? '' : ` — ${detail}`}`,
    )
    this.name = 'YouTubeApiCallError'
    this.method = method
    this.outcome = outcome
    this.classification = classification
  }

  /** Google's `reason` when the response carried one. */
  get reason(): string | undefined {
    return this.classification.reason
  }

  /** True when the caller must reconcile before it retries (spec §9.1). */
  get needsReconcile(): boolean {
    return this.outcome === 'uncertain'
  }
}

/** Just enough of T3's `TokenManager` for this client to be testable alone. */
export interface AccessTokenSource {
  getAccessToken(): Promise<string>
}

/**
 * Receives the stream key the moment it is parsed. The lifecycle writes it to the
 * vault; the API client keeps no copy. Rejecting here fails the call, which is
 * correct: a stream we cannot store the key for is unusable.
 */
export type StreamKeySink = (streamId: string, streamKey: string) => Promise<void>

export interface ConfigurationIssue {
  readonly type: string
  readonly severity: string
  readonly reason: string | null
  readonly description: string | null
}

export interface LiveStreamStatus {
  /** `active` | `created` | `error` | `inactive` | `ready` (spec §9.4(6)). */
  readonly streamStatus: string | null
  /** `good` | `ok` | `bad` | `noData`. */
  readonly healthStatus: string | null
  readonly lastUpdateTimeSeconds: number | null
  readonly configurationIssues: readonly ConfigurationIssue[]
}

/** A `liveStream` with the stream key removed. */
export interface LiveStreamSummary {
  readonly id: string
  readonly title: string | null
  readonly isReusable: boolean | null
  /** True when this response carried a key and it was handed to the sink. */
  readonly streamKeyStored: boolean
  readonly rtmpsIngestionAddress: string | null
  readonly rtmpsBackupIngestionAddress: string | null
  readonly status: LiveStreamStatus
}

export interface LiveBroadcastSummary {
  readonly id: string
  readonly title: string | null
  readonly scheduledStartTime: string | null
  readonly actualStartTime: string | null
  readonly liveChatId: string | null
  /** `complete` | `created` | `live` | `liveStarting` | `ready` | `revoked` | `testStarting` | `testing`. */
  readonly lifeCycleStatus: string | null
  readonly privacyStatus: string | null
  readonly boundStreamId: string | null
  readonly enableAutoStart: boolean | null
  readonly enableMonitorStream: boolean | null
}

export interface InsertLiveStreamInput {
  readonly title: string
  readonly resolution: StreamResolution
  readonly frameRate: StreamFrameRate
  readonly ingestionType: StreamIngestionType
  readonly isReusable: boolean
}

export interface InsertBroadcastInput {
  readonly title: string
  readonly description?: string
  readonly scheduledStartTime: string
  readonly privacyStatus: BroadcastPrivacyStatus
  readonly selfDeclaredMadeForKids: boolean
  readonly latencyPreference: BroadcastLatencyPreference
  readonly enableAutoStart: boolean
  readonly enableAutoStop: boolean
  readonly enableDvr: boolean
  readonly enableMonitorStream: boolean
}

/** `liveBroadcasts.transition` `broadcastStatus` values (checked 2026-08-17). */
export type BroadcastTransition = 'testing' | 'live' | 'complete'

/** `liveBroadcasts.list` filter: exactly one of these may be set. */
export type BroadcastListFilter =
  | { readonly ids: readonly string[] }
  | { readonly broadcastStatus: 'active' | 'all' | 'completed' | 'upcoming' }

export type StreamListFilter = { readonly ids: readonly string[] } | { readonly mine: true }

export interface YouTubeLiveApiOptions {
  readonly tokens: AccessTokenSource
  readonly clock: Clock
  readonly requestTimeoutMs: number
  readonly streamKeySink: StreamKeySink
  readonly baseUrl?: string
  readonly quota?: QuotaTracker
  readonly logger?: Logger
  /** Shared with the rest of the process so a leaked key is masked everywhere. */
  readonly redactor?: SecretRedactor
  readonly fetchFn?: typeof fetch
  /** Pages a `list` will follow at most. */
  readonly maxPages?: number
}

/**
 * The reserve exists for the calls that must still work at the end of a heavy
 * quota day: recovering or ending an existing broadcast (see `quota/tracker.ts`).
 * Everything else is refused once only the reserve is left.
 */
const RESERVE_METHODS: ReadonlySet<PlannedMethod> = new Set<PlannedMethod>([
  'liveBroadcasts.list',
  'liveBroadcasts.transition',
])

export class YouTubeLiveApi {
  readonly #tokens: AccessTokenSource
  readonly #clock: Clock
  readonly #timeoutMs: number
  readonly #streamKeySink: StreamKeySink
  readonly #baseUrl: string
  readonly #quota: QuotaTracker | undefined
  readonly #logger: Logger
  readonly #redactor: SecretRedactor
  readonly #fetch: typeof fetch
  readonly #maxPages: number

  constructor(options: YouTubeLiveApiOptions) {
    if (options.requestTimeoutMs <= 0) {
      throw new Error('requestTimeoutMs must be positive')
    }
    this.#tokens = options.tokens
    this.#clock = options.clock
    this.#timeoutMs = options.requestTimeoutMs
    this.#streamKeySink = options.streamKeySink
    this.#baseUrl = (options.baseUrl ?? YOUTUBE_API_BASE_URL).replace(/\/+$/, '')
    this.#quota = options.quota
    this.#logger = options.logger ?? silentLogger
    this.#redactor = options.redactor ?? new SecretRedactor()
    this.#fetch = options.fetchFn ?? globalThis.fetch
    this.#maxPages = options.maxPages ?? 4
  }

  // -------------------------------------------------------------- liveStreams

  async insertLiveStream(input: InsertLiveStreamInput): Promise<LiveStreamSummary> {
    const parsed = await this.#request('liveStreams.insert', {
      httpMethod: 'POST',
      path: '/liveStreams',
      query: { part: 'id,snippet,cdn,contentDetails,status' },
      body: {
        snippet: { title: input.title },
        cdn: {
          frameRate: input.frameRate,
          ingestionType: input.ingestionType,
          resolution: input.resolution,
        },
        contentDetails: { isReusable: input.isReusable },
      },
    })
    return this.#toLiveStream(parsed)
  }

  /** Streams owned by the authorized channel, or specific ids. */
  async listLiveStreams(
    filter: StreamListFilter,
    options: { readonly maxPages?: number } = {},
  ): Promise<LiveStreamSummary[]> {
    const query: Record<string, string> =
      'ids' in filter ? { id: filter.ids.join(',') } : { mine: 'true' }
    const items = await this.#listAll('liveStreams.list', '/liveStreams', {
      ...query,
      part: 'id,snippet,cdn,contentDetails,status',
      maxResults: '50',
    }, options.maxPages)
    const summaries: LiveStreamSummary[] = []
    for (const item of items) {
      summaries.push(await this.#toLiveStream(item))
    }
    return summaries
  }

  // ----------------------------------------------------------- liveBroadcasts

  async insertBroadcast(input: InsertBroadcastInput): Promise<LiveBroadcastSummary> {
    const parsed = await this.#request('liveBroadcasts.insert', {
      httpMethod: 'POST',
      path: '/liveBroadcasts',
      query: { part: 'id,snippet,contentDetails,status' },
      body: {
        snippet: {
          title: input.title,
          scheduledStartTime: input.scheduledStartTime,
          ...(input.description === undefined || input.description === ''
            ? {}
            : { description: input.description }),
        },
        status: {
          privacyStatus: input.privacyStatus,
          selfDeclaredMadeForKids: input.selfDeclaredMadeForKids,
        },
        contentDetails: {
          latencyPreference: input.latencyPreference,
          enableAutoStart: input.enableAutoStart,
          enableAutoStop: input.enableAutoStop,
          enableDvr: input.enableDvr,
          monitorStream: { enableMonitorStream: input.enableMonitorStream },
        },
      },
    })
    return toLiveBroadcast(parsed)
  }

  async bindBroadcast(input: {
    readonly broadcastId: string
    readonly streamId: string
  }): Promise<LiveBroadcastSummary> {
    const parsed = await this.#request('liveBroadcasts.bind', {
      httpMethod: 'POST',
      path: '/liveBroadcasts/bind',
      query: {
        id: input.broadcastId,
        streamId: input.streamId,
        part: 'id,snippet,contentDetails,status',
      },
    })
    return toLiveBroadcast(parsed)
  }

  async transitionBroadcast(input: {
    readonly broadcastId: string
    readonly broadcastStatus: BroadcastTransition
  }): Promise<LiveBroadcastSummary> {
    const parsed = await this.#request('liveBroadcasts.transition', {
      httpMethod: 'POST',
      path: '/liveBroadcasts/transition',
      query: {
        id: input.broadcastId,
        broadcastStatus: input.broadcastStatus,
        part: 'id,snippet,contentDetails,status',
      },
    })
    return toLiveBroadcast(parsed)
  }

  /**
   * `broadcastStatus`, `id` and `mine` are mutually exclusive — "specify exactly
   * one" — and `broadcastType` defaults to `event`, which would hide a persistent
   * broadcast from a reconcile, so it is always sent as `all`
   * (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list,
   * checked 2026-08-17).
   */
  async listBroadcasts(
    filter: BroadcastListFilter,
    options: { readonly maxPages?: number } = {},
  ): Promise<LiveBroadcastSummary[]> {
    const query: Record<string, string> =
      'ids' in filter ? { id: filter.ids.join(',') } : { broadcastStatus: filter.broadcastStatus }
    const items = await this.#listAll('liveBroadcasts.list', '/liveBroadcasts', {
      ...query,
      broadcastType: 'all',
      part: 'id,snippet,contentDetails,status',
      maxResults: '50',
    }, options.maxPages)
    return items.map(toLiveBroadcast)
  }

  // ------------------------------------------------------------------ internals

  async #listAll(
    method: PlannedMethod,
    path: string,
    query: Record<string, string>,
    maxPages = this.#maxPages,
  ): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = []
    let pageToken: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const parsed = await this.#request(method, {
        httpMethod: 'GET',
        path,
        query: { ...query, ...(pageToken === undefined ? {} : { pageToken }) },
      })
      for (const item of readArray(parsed['items'])) {
        collected.push(asRecord(item, 'list item'))
      }
      const next = readOptionalString(parsed, 'nextPageToken')
      if (next === undefined) {
        return collected
      }
      pageToken = next
    }
    // Bounded on purpose, and said out loud: a silent truncation would read as
    // "there is no such broadcast" during a reconcile.
    this.#logger.warn('list truncated at the page bound', { method, maxPages })
    return collected
  }

  async #request(
    method: PlannedMethod,
    request: {
      readonly httpMethod: 'GET' | 'POST'
      readonly path: string
      readonly query: Record<string, string>
      readonly body?: unknown
    },
  ): Promise<Record<string, unknown>> {
    this.#assertQuota(method)

    const accessToken = await this.#accessToken(method)
    const url = new URL(`${this.#baseUrl}${request.path}`)
    for (const [key, value] of Object.entries(request.query)) {
      url.searchParams.set(key, value)
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = this.#clock.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)

    let response: Response
    try {
      response = await this.#fetch(url, {
        method: request.httpMethod,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      })
    } catch (error) {
      // The request was dispatched, so YouTube may have applied it. Counting the
      // unit here overestimates rather than under: an unbooked call is how a day
      // silently runs past its budget.
      this.#recordQuota(method)
      throw this.#transportFailure(method, error, timedOut)
    } finally {
      this.#clock.clearTimeout(timer)
    }

    this.#recordQuota(method)

    const text = await response.text()
    if (!response.ok) {
      throw this.#httpFailure(method, response, text)
    }
    const parsed = text === '' ? {} : safeParse(text)
    // Registered before anything else touches the payload: from here on even an
    // accidental log of the object is masked.
    this.#absorbStreamKeys(parsed)
    return asRecord(parsed, `${method} response`)
  }

  #assertQuota(method: PlannedMethod): void {
    const quota = this.#quota
    if (quota === undefined) {
      return
    }
    const blocked = RESERVE_METHODS.has(method) ? quota.isExhausted(method) : !quota.canSpend(method)
    if (blocked) {
      throw new YouTubeApiCallError(
        method,
        'not_attempted',
        { kind: 'quotaExceeded', action: 'degraded', retryable: false },
        RESERVE_METHODS.has(method)
          ? 'the daily quota is exhausted, reserve included'
          : 'only the recovery reserve is left',
      )
    }
  }

  #recordQuota(method: PlannedMethod): void {
    this.#quota?.record(method)
  }

  async #accessToken(method: PlannedMethod): Promise<string> {
    try {
      return await this.#tokens.getAccessToken()
    } catch (error) {
      // No request was made, so nothing can have been applied.
      throw new YouTubeApiCallError(
        method,
        'not_attempted',
        { kind: 'unauthorized', action: 'safe_stopped', retryable: false },
        this.#redactor.redactError(error),
      )
    }
  }

  #transportFailure(method: PlannedMethod, error: unknown, timedOut: boolean): Error {
    if (error instanceof YouTubeApiCallError) {
      return error
    }
    const errorCode = timedOut ? 'ETIMEDOUT' : nodeErrorCode(error)
    const classification = classifyYouTubeApiError({
      ...(errorCode === undefined ? {} : { errorCode }),
      nowMs: Date.parse(this.#clock.nowUtcIso()),
    })
    return new YouTubeApiCallError(
      method,
      'uncertain',
      classification,
      timedOut ? `timed out after ${String(this.#timeoutMs)}ms` : errorName(error),
    )
  }

  #httpFailure(method: PlannedMethod, response: Response, text: string): Error {
    const classification = classifyYouTubeApiError({
      httpStatus: response.status,
      body: text,
      retryAfterHeader: response.headers.get('retry-after') ?? undefined,
      nowMs: Date.parse(this.#clock.nowUtcIso()),
    })
    // A 4xx is YouTube's decision: the resource was not created or changed. A 5xx
    // is the server's own failure and says nothing about whether it applied.
    const outcome: ApiCallOutcome = response.status >= 500 ? 'uncertain' : 'rejected'
    // Only the status and the machine reason travel; response bodies can quote the
    // request, which for `liveStreams` would mean the stream key.
    return new YouTubeApiCallError(method, outcome, classification, `HTTP ${String(response.status)}`)
  }

  /**
   * Hands every `cdn.ingestionInfo.streamName` in a response to the vault sink and
   * registers it with the redactor. Called on the raw parsed payload so the key is
   * masked before any other code — including an error path — can see it.
   */
  #absorbStreamKeys(parsed: unknown): void {
    for (const key of collectStreamNames(parsed)) {
      this.#redactor.register(key)
    }
  }

  async #toLiveStream(item: Record<string, unknown>): Promise<LiveStreamSummary> {
    const id = requireString(item, 'id', 'liveStream.id')
    const snippet = optionalRecord(item, 'snippet')
    const cdn = optionalRecord(item, 'cdn')
    const contentDetails = optionalRecord(item, 'contentDetails')
    const ingestionInfo = cdn === undefined ? undefined : optionalRecord(cdn, 'ingestionInfo')

    const streamKey =
      ingestionInfo === undefined ? undefined : readOptionalString(ingestionInfo, 'streamName')
    if (streamKey !== undefined) {
      this.#redactor.register(streamKey)
      await this.#streamKeySink(id, streamKey)
    }

    return {
      id,
      title: snippet === undefined ? null : (readOptionalString(snippet, 'title') ?? null),
      isReusable:
        contentDetails === undefined
          ? null
          : (readOptionalBoolean(contentDetails, 'isReusable') ?? null),
      streamKeyStored: streamKey !== undefined,
      rtmpsIngestionAddress:
        ingestionInfo === undefined
          ? null
          : (readOptionalString(ingestionInfo, 'rtmpsIngestionAddress') ?? null),
      rtmpsBackupIngestionAddress:
        ingestionInfo === undefined
          ? null
          : (readOptionalString(ingestionInfo, 'rtmpsBackupIngestionAddress') ?? null),
      status: toLiveStreamStatus(optionalRecord(item, 'status')),
    }
  }
}

function toLiveStreamStatus(status: Record<string, unknown> | undefined): LiveStreamStatus {
  if (status === undefined) {
    return { streamStatus: null, healthStatus: null, lastUpdateTimeSeconds: null, configurationIssues: [] }
  }
  const health = optionalRecord(status, 'healthStatus')
  return {
    streamStatus: readOptionalString(status, 'streamStatus') ?? null,
    healthStatus: health === undefined ? null : (readOptionalString(health, 'status') ?? null),
    lastUpdateTimeSeconds:
      health === undefined ? null : (readOptionalNumberish(health, 'lastUpdateTimeSeconds') ?? null),
    configurationIssues:
      health === undefined
        ? []
        : readArray(health['configurationIssues']).map((entry) => {
            const issue = asRecord(entry, 'configurationIssue')
            return {
              type: readOptionalString(issue, 'type') ?? 'unknown',
              severity: readOptionalString(issue, 'severity') ?? 'unknown',
              reason: readOptionalString(issue, 'reason') ?? null,
              description: readOptionalString(issue, 'description') ?? null,
            }
          }),
  }
}

function toLiveBroadcast(item: Record<string, unknown>): LiveBroadcastSummary {
  const snippet = optionalRecord(item, 'snippet')
  const status = optionalRecord(item, 'status')
  const contentDetails = optionalRecord(item, 'contentDetails')
  const monitorStream =
    contentDetails === undefined ? undefined : optionalRecord(contentDetails, 'monitorStream')

  return {
    id: requireString(item, 'id', 'liveBroadcast.id'),
    title: snippet === undefined ? null : (readOptionalString(snippet, 'title') ?? null),
    scheduledStartTime:
      snippet === undefined ? null : (readOptionalString(snippet, 'scheduledStartTime') ?? null),
    actualStartTime:
      snippet === undefined ? null : (readOptionalString(snippet, 'actualStartTime') ?? null),
    liveChatId: snippet === undefined ? null : (readOptionalString(snippet, 'liveChatId') ?? null),
    lifeCycleStatus:
      status === undefined ? null : (readOptionalString(status, 'lifeCycleStatus') ?? null),
    privacyStatus:
      status === undefined ? null : (readOptionalString(status, 'privacyStatus') ?? null),
    boundStreamId:
      contentDetails === undefined
        ? null
        : (readOptionalString(contentDetails, 'boundStreamId') ?? null),
    enableAutoStart:
      contentDetails === undefined
        ? null
        : (readOptionalBoolean(contentDetails, 'enableAutoStart') ?? null),
    enableMonitorStream:
      monitorStream === undefined
        ? null
        : (readOptionalBoolean(monitorStream, 'enableMonitorStream') ?? null),
  }
}

/** Every `streamName` anywhere in a payload, however it is nested. */
function collectStreamNames(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectStreamNames(entry, found)
    return found
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'streamName' && typeof nested === 'string' && nested !== '') {
        found.push(nested)
        continue
      }
      collectStreamNames(nested, found)
    }
  }
  return found
}

export class YouTubeApiShapeError extends Error {
  constructor(message: string) {
    super(`unexpected youtube api response: ${message}`)
    this.name = 'YouTubeApiShapeError'
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // The body itself is never quoted: it can echo request content.
    throw new YouTubeApiShapeError('body is not JSON')
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new YouTubeApiShapeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalRecord(
  container: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = container[key]
  if (value === undefined || value === null) {
    return undefined
  }
  return asRecord(value, key)
}

function readArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new YouTubeApiShapeError('expected an array')
  }
  return value
}

function requireString(
  container: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = readOptionalString(container, key)
  if (value === undefined) {
    throw new YouTubeApiShapeError(`${label} is missing`)
  }
  return value
}

function readOptionalString(
  container: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = container[key]
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new YouTubeApiShapeError(`${key} must be a string`)
  }
  return value
}

function readOptionalBoolean(
  container: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = container[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new YouTubeApiShapeError(`${key} must be a boolean`)
  }
  return value
}

/** Google serializes 64-bit integers as strings; both forms are accepted. */
function readOptionalNumberish(
  container: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = container[key]
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new YouTubeApiShapeError(`${key} must be a number`)
  }
  return parsed
}

function nodeErrorCode(error: unknown): string | undefined {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return 'ETIMEDOUT'
    }
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      return code
    }
    const cause = (error as { cause?: unknown }).cause
    if (cause !== undefined && cause !== null) {
      return nodeErrorCode(cause)
    }
  }
  return undefined
}

function errorName(error: unknown): string {
  return error instanceof Error ? `${error.name}` : 'transport failure'
}
