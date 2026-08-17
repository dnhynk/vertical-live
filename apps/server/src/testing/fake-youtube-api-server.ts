import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Fake YouTube Live Streaming API for tests (`docs/tasks/TASK_SPECS.md` §T10
 * acceptance 1: 가짜 API 서버로 정상 경로, timeout→reconcile, 3종 한도 오류,
 * invalidAutoStart fallback).
 *
 * It is a real loopback HTTP server holding real state, so the production request
 * path — URL building, headers, JSON bodies, error parsing — is what the tests
 * exercise. Two properties matter for this task in particular:
 *
 * - a queued **delay** still applies the request. That is what makes a client-side
 *   timeout a genuinely uncertain outcome: the resource exists, the caller does not
 *   know it, and only a `list` can tell (spec §9.1).
 * - error bodies follow the documented shape
 *   `{"error":{"code":403,"errors":[{"domain":…,"reason":…}]}}` with the reason
 *   strings from https://developers.google.com/youtube/v3/live/docs/errors
 *   (checked 2026-08-17).
 *
 * Every value it invents is an obvious synthetic string (CLAUDE.md §3: no real
 * credentials, ids or names in fixtures).
 */

export type FakeApiMethod =
  | 'liveStreams.insert'
  | 'liveStreams.list'
  | 'liveBroadcasts.insert'
  | 'liveBroadcasts.list'
  | 'liveBroadcasts.bind'
  | 'liveBroadcasts.transition'

export interface FakeFailure {
  readonly status: number
  readonly reason?: string
  readonly domain?: string
  readonly message?: string
  readonly retryAfter?: string
}

export interface FakeRequest {
  readonly method: FakeApiMethod
  readonly httpMethod: string
  readonly query: Readonly<Record<string, string>>
  readonly body: unknown
  readonly authorization: string | undefined
}

export interface FakeStream {
  id: string
  title: string
  isReusable: boolean
  resolution: string
  frameRate: string
  ingestionType: string
  /** Synthetic stand-in for `cdn.ingestionInfo.streamName`. */
  streamKey: string
  streamStatus: 'active' | 'created' | 'error' | 'inactive' | 'ready'
  healthStatus: 'good' | 'ok' | 'bad' | 'noData'
  configurationIssues: { type: string; severity: string; reason?: string; description?: string }[]
}

export interface FakeBroadcast {
  id: string
  title: string
  description: string | undefined
  scheduledStartTime: string
  privacyStatus: string
  selfDeclaredMadeForKids: boolean
  latencyPreference: string
  enableAutoStart: boolean
  enableAutoStop: boolean
  enableDvr: boolean
  enableMonitorStream: boolean
  lifeCycleStatus:
    | 'complete'
    | 'created'
    | 'live'
    | 'liveStarting'
    | 'ready'
    | 'revoked'
    | 'testStarting'
    | 'testing'
  liveChatId: string
  boundStreamId: string | null
  actualStartTime: string | null
}

const LIFECYCLE_BY_FILTER: Readonly<Record<string, readonly FakeBroadcast['lifeCycleStatus'][]>> = {
  active: ['live', 'liveStarting', 'testing', 'testStarting'],
  upcoming: ['created', 'ready'],
  completed: ['complete', 'revoked'],
}

/**
 * The `part` names each method documents, and the resource's full property set
 * (both checked 2026-08-17 — see `METHOD_ALLOWED_PARTS` in
 * `youtube/broadcast/api.ts` for the per-page citations).
 *
 * Review round 1 (B1): the fake used to accept any `part`, so a request shape the
 * real API rejects (`liveStreams.list` + `contentDetails`) passed every test and
 * would have failed in production. Requests are now validated the way the API
 * documents, and the response carries **only** the parts that were asked for — which
 * is what makes a status-only poll verifiably free of the stream key.
 */
const ALLOWED_PARTS: Readonly<Record<FakeApiMethod, readonly string[]>> = {
  'liveStreams.insert': ['id', 'snippet', 'cdn', 'contentDetails', 'status'],
  'liveStreams.list': ['id', 'snippet', 'cdn', 'status'],
  'liveBroadcasts.insert': ['id', 'snippet', 'contentDetails', 'status'],
  'liveBroadcasts.list': ['id', 'snippet', 'contentDetails', 'monetizationDetails', 'status'],
  'liveBroadcasts.bind': ['id', 'snippet', 'contentDetails', 'status'],
  'liveBroadcasts.transition': ['id', 'snippet', 'contentDetails', 'status'],
}

/** Property names that exist on the resource at all, whatever the method accepts. */
const RESOURCE_PARTS: Readonly<Record<'liveStream' | 'liveBroadcast', readonly string[]>> = {
  liveStream: ['id', 'snippet', 'cdn', 'contentDetails', 'status'],
  liveBroadcast: ['id', 'snippet', 'contentDetails', 'monetizationDetails', 'statistics', 'status'],
}

/** A queued hold: the request is applied, then the response is withheld. */
export interface AppliedHold {
  /** Resolves once the server has applied the request. */
  readonly applied: Promise<void>
  /** Lets the withheld response go out. */
  release(): void
}

export class FakeYouTubeApiServer {
  readonly requests: FakeRequest[] = []
  readonly streams = new Map<string, FakeStream>()
  readonly broadcasts = new Map<string, FakeBroadcast>()

  /** Queued failures, consumed one per matching call. */
  readonly #failures = new Map<FakeApiMethod, FakeFailure[]>()
  /** Queued response delays in ms, consumed one per matching call. */
  readonly #delays = new Map<FakeApiMethod, number[]>()
  /** Queued applied-but-withheld holds, consumed one per matching call. */
  readonly #holds = new Map<FakeApiMethod, InternalHold[]>()

  readonly #server: Server
  #baseUrl = ''
  #streamSerial = 0
  #broadcastSerial = 0
  /** Set when a transition should report the bound stream as inactive. */
  streamInactiveOnTransition = false
  /**
   * Called after a request is recorded and before it is applied. Lets a test change
   * the server's state at an exact point in the sequence — e.g. another host
   * creating a stream while this one's insert is in flight.
   */
  onRequest: ((request: FakeRequest) => void) | undefined

  private constructor(server: Server) {
    this.#server = server
    server.on('request', (req, res) => {
      void this.#handle(req, res)
    })
  }

  static async start(): Promise<FakeYouTubeApiServer> {
    const server = createServer()
    const fake = new FakeYouTubeApiServer(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    fake.#baseUrl = `http://127.0.0.1:${address.port}`
    return fake
  }

  get baseUrl(): string {
    return `${this.#baseUrl}/youtube/v3`
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  queueFailure(method: FakeApiMethod, failure: FakeFailure): void {
    const queue = this.#failures.get(method) ?? []
    queue.push(failure)
    this.#failures.set(method, queue)
  }

  /** The request is still applied after the delay — see the module comment. */
  queueDelay(method: FakeApiMethod, delayMs: number): void {
    const queue = this.#delays.get(method) ?? []
    queue.push(delayMs)
    this.#delays.set(method, queue)
  }

  /**
   * Models "applied but unknown" without a wall-clock race (review round 1, M2): the
   * next call to `method` is applied, `applied` resolves, and the response is held
   * until `release()`. A test awaits `applied` — so the mutation provably happened —
   * and only then drives its client-side timeout.
   */
  holdApplied(method: FakeApiMethod): AppliedHold {
    let signalApplied: () => void = () => {}
    const applied = new Promise<void>((resolve) => {
      signalApplied = resolve
    })
    let releaseResponse: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const queue = this.#holds.get(method) ?? []
    queue.push({ signalApplied, released })
    this.#holds.set(method, queue)
    return { applied, release: releaseResponse }
  }

  requestsFor(method: FakeApiMethod): FakeRequest[] {
    return this.requests.filter((request) => request.method === method)
  }

  seedStream(overrides: Partial<FakeStream> = {}): FakeStream {
    this.#streamSerial += 1
    const serial = this.#streamSerial
    const stream: FakeStream = {
      id: `synthetic-stream-${String(serial)}`,
      title: 'vertical-live ingest',
      isReusable: true,
      resolution: 'variable',
      frameRate: 'variable',
      ingestionType: 'rtmp',
      streamKey: `synthetic-stream-key-${String(serial).padStart(4, '0')}`,
      streamStatus: 'inactive',
      healthStatus: 'noData',
      configurationIssues: [],
      ...overrides,
    }
    this.streams.set(stream.id, stream)
    return stream
  }

  seedBroadcast(overrides: Partial<FakeBroadcast> = {}): FakeBroadcast {
    this.#broadcastSerial += 1
    const serial = this.#broadcastSerial
    const broadcast: FakeBroadcast = {
      id: `synthetic-broadcast-${String(serial)}`,
      title: 'Autonomous Vertical Live',
      description: undefined,
      scheduledStartTime: '2026-01-01T00:02:00.000Z',
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
      latencyPreference: 'ultraLow',
      enableAutoStart: false,
      enableAutoStop: false,
      enableDvr: false,
      enableMonitorStream: true,
      lifeCycleStatus: 'ready',
      liveChatId: `synthetic-live-chat-${String(serial)}`,
      boundStreamId: null,
      actualStartTime: null,
      ...overrides,
    }
    this.broadcasts.set(broadcast.id, broadcast)
    return broadcast
  }

  // ----------------------------------------------------------------- handling

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.#baseUrl)
    const raw = await readBody(req)
    const query = Object.fromEntries(url.searchParams)
    const httpMethod = req.method ?? 'GET'
    const method = resolveMethod(httpMethod, url.pathname)

    if (method === null) {
      json(res, 404, errorBody(404, 'notFound', 'global', 'no such endpoint'))
      return
    }
    const body: unknown = raw === '' ? undefined : JSON.parse(raw)
    const request: FakeRequest = {
      method,
      httpMethod,
      query,
      body,
      authorization: req.headers.authorization,
    }
    this.requests.push(request)
    this.onRequest?.(request)

    if (
      req.headers.authorization === undefined ||
      !req.headers.authorization.startsWith('Bearer ')
    ) {
      json(res, 401, errorBody(401, 'authError', 'global', 'missing bearer token'))
      return
    }

    const partError = validateParts(method, query['part'])
    if (partError !== null) {
      json(res, 400, errorBody(400, partError, 'youtube.part', 'invalid part parameter'))
      return
    }

    const delayMs = this.#delays.get(method)?.shift()
    const hold = this.#holds.get(method)?.shift()
    const failure = this.#failures.get(method)?.shift()

    const respond = (): void => {
      if (failure !== undefined) {
        const headers: Record<string, string> =
          failure.retryAfter === undefined ? {} : { 'retry-after': failure.retryAfter }
        // The request is *not* applied when a failure is queued: a rejection means
        // YouTube changed nothing, which is exactly what the client assumes.
        json(
          res,
          failure.status,
          errorBody(
            failure.status,
            failure.reason ?? 'unknown',
            failure.domain ?? 'youtube.liveBroadcast',
            failure.message ?? 'synthetic failure',
          ),
          headers,
        )
        return
      }
      try {
        json(res, 200, this.#apply(method, query, body))
      } catch (error) {
        const known = error as { status?: number; reason?: string; domain?: string }
        json(
          res,
          known.status ?? 500,
          errorBody(
            known.status ?? 500,
            known.reason ?? 'internalError',
            known.domain ?? 'youtube.liveBroadcast',
            'synthetic failure',
          ),
        )
      }
    }

    if (hold !== undefined) {
      // Apply first, signal, then wait: the caller learns the mutation landed before
      // it aborts, so "applied but unknown" is a fact rather than a timing accident.
      const applied = failure === undefined ? this.#apply(method, query, body) : undefined
      hold.signalApplied()
      await hold.released
      if (applied === undefined) {
        respond()
        return
      }
      json(res, 200, applied)
      return
    }

    if (delayMs === undefined) {
      respond()
      return
    }
    // Applied first, answered late: the caller's timeout fires while the resource
    // already exists.
    const applied = failure === undefined ? this.#apply(method, query, body) : undefined
    setTimeout(() => {
      if (applied === undefined) {
        respond()
        return
      }
      json(res, 200, applied)
    }, delayMs).unref()
  }

  #apply(
    method: FakeApiMethod,
    query: Record<string, string>,
    body: unknown,
  ): Record<string, unknown> {
    const parts = requestedParts(query['part'])
    switch (method) {
      case 'liveStreams.insert':
        return streamResource(this.#insertStream(body), parts)
      case 'liveStreams.list':
        return this.#listStreams(query, parts)
      case 'liveBroadcasts.insert':
        return broadcastResource(this.#insertBroadcast(body), parts)
      case 'liveBroadcasts.list':
        return this.#listBroadcasts(query, parts)
      case 'liveBroadcasts.bind':
        return broadcastResource(this.#bind(query), parts)
      case 'liveBroadcasts.transition':
        return broadcastResource(this.#transition(query), parts)
    }
  }

  #insertStream(body: unknown): FakeStream {
    const root = asRecord(body)
    const snippet = asRecord(root['snippet'])
    const cdn = asRecord(root['cdn'])
    const contentDetails = asRecord(root['contentDetails'])
    const title = typeof snippet['title'] === 'string' ? snippet['title'] : ''
    if (title === '') {
      throw fail(400, 'titleRequired', 'youtube.liveStream')
    }
    return this.seedStream({
      title,
      resolution: String(cdn['resolution'] ?? ''),
      frameRate: String(cdn['frameRate'] ?? ''),
      ingestionType: String(cdn['ingestionType'] ?? ''),
      isReusable: contentDetails['isReusable'] === true,
      streamStatus: 'created',
    })
  }

  #listStreams(query: Record<string, string>, parts: readonly string[]): Record<string, unknown> {
    const all = [...this.streams.values()]
    const ids = query['id']?.split(',').filter((id) => id !== '')
    if (ids === undefined && query['mine'] !== 'true') {
      // "Specify exactly one" filter, like the real method.
      throw fail(400, 'missingRequiredParameter', 'youtube.liveStream')
    }
    const selected = ids === undefined ? all : all.filter((stream) => ids.includes(stream.id))
    return page(
      selected.map((stream) => streamResource(stream, parts)),
      query,
    )
  }

  #insertBroadcast(body: unknown): FakeBroadcast {
    const root = asRecord(body)
    const snippet = asRecord(root['snippet'])
    const status = asRecord(root['status'])
    const contentDetails = asRecord(root['contentDetails'])
    const monitorStream = asRecord(contentDetails['monitorStream'])

    const scheduledStartTime = String(snippet['scheduledStartTime'] ?? '')
    if (scheduledStartTime === '') {
      throw fail(400, 'scheduledStartTimeRequired', 'youtube.liveBroadcast')
    }
    const privacyStatus = String(status['privacyStatus'] ?? '')
    if (privacyStatus === '') {
      throw fail(400, 'privacyStatusRequired', 'youtube.liveBroadcast')
    }
    const enableAutoStart = contentDetails['enableAutoStart'] === true
    return this.seedBroadcast({
      title: String(snippet['title'] ?? ''),
      ...(typeof snippet['description'] === 'string'
        ? { description: snippet['description'] }
        : {}),
      scheduledStartTime,
      privacyStatus,
      selfDeclaredMadeForKids: status['selfDeclaredMadeForKids'] === true,
      latencyPreference: String(contentDetails['latencyPreference'] ?? 'normal'),
      enableAutoStart,
      enableAutoStop: contentDetails['enableAutoStop'] === true,
      enableDvr: contentDetails['enableDvr'] === true,
      enableMonitorStream: monitorStream['enableMonitorStream'] === true,
      lifeCycleStatus: 'created',
    })
  }

  #listBroadcasts(
    query: Record<string, string>,
    parts: readonly string[],
  ): Record<string, unknown> {
    const filters = ['id', 'mine', 'broadcastStatus'].filter(
      (name) => query[name] !== undefined && query[name] !== '',
    )
    if (filters.length !== 1) {
      // https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list:
      // "Specify exactly one" of broadcastStatus, id, mine.
      throw fail(400, 'incompatibleParameters', 'youtube.liveBroadcast')
    }
    const all = [...this.broadcasts.values()]
    const ids = query['id']?.split(',').filter((id) => id !== '')
    let selected = ids === undefined ? all : all.filter((broadcast) => ids.includes(broadcast.id))
    const filter = query['broadcastStatus']
    if (filter !== undefined && filter !== 'all') {
      const allowed = LIFECYCLE_BY_FILTER[filter] ?? []
      selected = selected.filter((broadcast) => allowed.includes(broadcast.lifeCycleStatus))
    }
    return page(
      selected.map((broadcast) => broadcastResource(broadcast, parts)),
      query,
    )
  }

  #bind(query: Record<string, string>): FakeBroadcast {
    const broadcast = this.broadcasts.get(query['id'] ?? '')
    if (broadcast === undefined) {
      throw fail(404, 'liveBroadcastNotFound', 'youtube.liveBroadcast')
    }
    const streamId = query['streamId']
    if (streamId === undefined || streamId === '') {
      broadcast.boundStreamId = null
      return broadcast
    }
    if (!this.streams.has(streamId)) {
      throw fail(404, 'liveStreamNotFound', 'youtube.liveStream')
    }
    broadcast.boundStreamId = streamId
    broadcast.lifeCycleStatus =
      broadcast.lifeCycleStatus === 'created' ? 'ready' : broadcast.lifeCycleStatus
    return broadcast
  }

  #transition(query: Record<string, string>): FakeBroadcast {
    const broadcast = this.broadcasts.get(query['id'] ?? '')
    if (broadcast === undefined) {
      throw fail(404, 'liveBroadcastNotFound', 'youtube.liveBroadcast')
    }
    const target = query['broadcastStatus']
    if (target === broadcast.lifeCycleStatus) {
      throw fail(403, 'redundantTransition', 'youtube.liveBroadcast')
    }
    if (this.streamInactiveOnTransition && target !== 'complete') {
      throw fail(403, 'errorStreamInactive', 'youtube.liveBroadcast')
    }
    switch (target) {
      case 'testing':
        broadcast.lifeCycleStatus = 'testing'
        return broadcast
      case 'live':
        broadcast.lifeCycleStatus = 'live'
        broadcast.actualStartTime = '2026-01-01T00:03:00.000Z'
        return broadcast
      case 'complete':
        broadcast.lifeCycleStatus = 'complete'
        return broadcast
      default:
        throw fail(400, 'statusRequired', 'youtube.liveBroadcast')
    }
  }
}

function resolveMethod(httpMethod: string, pathname: string): FakeApiMethod | null {
  const path = pathname.replace(/^\/youtube\/v3/, '')
  if (path === '/liveStreams') {
    return httpMethod === 'POST' ? 'liveStreams.insert' : 'liveStreams.list'
  }
  if (path === '/liveBroadcasts') {
    return httpMethod === 'POST' ? 'liveBroadcasts.insert' : 'liveBroadcasts.list'
  }
  if (path === '/liveBroadcasts/bind' && httpMethod === 'POST') {
    return 'liveBroadcasts.bind'
  }
  if (path === '/liveBroadcasts/transition' && httpMethod === 'POST') {
    return 'liveBroadcasts.transition'
  }
  return null
}

function streamResource(stream: FakeStream, parts: readonly string[]): Record<string, unknown> {
  return keepParts(parts, {
    kind: 'youtube#liveStream',
    id: stream.id,
    snippet: { title: stream.title },
    cdn: {
      frameRate: stream.frameRate,
      ingestionType: stream.ingestionType,
      resolution: stream.resolution,
      ingestionInfo: {
        streamName: stream.streamKey,
        ingestionAddress: 'rtmp://synthetic.example.invalid/live2',
        backupIngestionAddress: 'rtmp://synthetic-backup.example.invalid/live2?backup=1',
        rtmpsIngestionAddress: 'rtmps://synthetic.example.invalid/live2',
        rtmpsBackupIngestionAddress: 'rtmps://synthetic-backup.example.invalid/live2?backup=1',
      },
    },
    contentDetails: { isReusable: stream.isReusable },
    status: {
      streamStatus: stream.streamStatus,
      healthStatus: {
        status: stream.healthStatus,
        lastUpdateTimeSeconds: '1767225600',
        configurationIssues: stream.configurationIssues,
      },
    },
  })
}

function broadcastResource(
  broadcast: FakeBroadcast,
  parts: readonly string[],
): Record<string, unknown> {
  return keepParts(parts, {
    kind: 'youtube#liveBroadcast',
    id: broadcast.id,
    snippet: {
      title: broadcast.title,
      ...(broadcast.description === undefined ? {} : { description: broadcast.description }),
      scheduledStartTime: broadcast.scheduledStartTime,
      ...(broadcast.actualStartTime === null ? {} : { actualStartTime: broadcast.actualStartTime }),
      liveChatId: broadcast.liveChatId,
    },
    status: {
      lifeCycleStatus: broadcast.lifeCycleStatus,
      privacyStatus: broadcast.privacyStatus,
      selfDeclaredMadeForKids: broadcast.selfDeclaredMadeForKids,
      madeForKids: false,
      recordingStatus: broadcast.lifeCycleStatus === 'live' ? 'recording' : 'notRecording',
    },
    contentDetails: {
      ...(broadcast.boundStreamId === null ? {} : { boundStreamId: broadcast.boundStreamId }),
      latencyPreference: broadcast.latencyPreference,
      enableAutoStart: broadcast.enableAutoStart,
      enableAutoStop: broadcast.enableAutoStop,
      enableDvr: broadcast.enableDvr,
      monitorStream: { enableMonitorStream: broadcast.enableMonitorStream },
    },
  })
}

/** Drops every part the request did not ask for. `kind` and `id` always travel. */
function keepParts(
  parts: readonly string[],
  resource: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(resource)) {
    if (key === 'kind' || key === 'id' || parts.includes(key)) {
      kept[key] = value
    }
  }
  return kept
}

function requestedParts(part: string | undefined): readonly string[] {
  return (part ?? '').split(',').filter((entry) => entry !== '')
}

/**
 * `null` when the `part` value is acceptable, otherwise the documented reason:
 * `unknownPart` for a name the resource does not have and `unexpectedPart` for one
 * this method does not accept (https://developers.google.com/youtube/v3/docs/errors,
 * checked 2026-08-17).
 */
function validateParts(method: FakeApiMethod, part: string | undefined): string | null {
  const parts = requestedParts(part)
  if (parts.length === 0) {
    return 'missingRequiredParameter'
  }
  const resource = method.startsWith('liveStreams') ? 'liveStream' : 'liveBroadcast'
  for (const entry of parts) {
    if (!RESOURCE_PARTS[resource].includes(entry)) {
      return 'unknownPart'
    }
    if (!ALLOWED_PARTS[method].includes(entry)) {
      return 'unexpectedPart'
    }
  }
  return null
}

interface InternalHold {
  readonly signalApplied: () => void
  readonly released: Promise<void>
}

function page(
  items: Record<string, unknown>[],
  query: Record<string, string>,
): Record<string, unknown> {
  const maxResults = Number(query['maxResults'] ?? '5')
  const offset = Number(query['pageToken'] ?? '0')
  const slice = items.slice(offset, offset + maxResults)
  const nextOffset = offset + slice.length
  return {
    kind: 'youtube#liveStreamListResponse',
    items: slice,
    pageInfo: { totalResults: items.length, resultsPerPage: slice.length },
    ...(nextOffset < items.length ? { nextPageToken: String(nextOffset) } : {}),
  }
}

function errorBody(
  code: number,
  reason: string,
  domain: string,
  message: string,
): Record<string, unknown> {
  return {
    error: {
      code,
      message,
      errors: [{ message, domain, reason }],
    },
  }
}

function fail(
  status: number,
  reason: string,
  domain: string,
): { status: number; reason: string; domain: string } {
  return { status, reason, domain }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}
