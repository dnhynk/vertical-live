import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { systemClock, type Clock } from '../../clock.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { SecretRedactor } from '../../secrets/redaction.js'
import { FakeYouTubeApiServer } from '../../testing/fake-youtube-api-server.js'
import { AuthConfigError } from '../auth/config.js'
import { QuotaTracker } from '../quota/tracker.js'
import { YouTubeApiCallError, YouTubeApiShapeError, YouTubeLiveApi } from './api.js'
import { loadBroadcastConfig } from './config.js'
import { RecordingLogger, staticTokens } from './test-support.js'

/**
 * The transport contract the lifecycle depends on: which failures are *definitely*
 * not applied, which may be, and that no response path can carry a stream key out
 * of this layer (§T10 acceptance 1 and 2).
 */

let server: FakeYouTubeApiServer | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await server?.stop()
  server = undefined
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

interface Harness {
  readonly api: YouTubeLiveApi
  readonly logger: RecordingLogger
  readonly redactor: SecretRedactor
  readonly quota: QuotaTracker
  readonly keys: { streamId: string; streamKey: string }[]
}

async function harness(
  options: {
    readonly clock?: Clock
    readonly requestTimeoutMs?: number
    readonly maxPages?: number
    readonly reserveUnits?: number
    readonly dailyUnits?: number
    readonly fetchFn?: typeof fetch
    readonly baseUrl?: string
    /** Shared so a test can register a secret before the call that echoes it. */
    readonly redactor?: SecretRedactor
  } = {},
): Promise<Harness> {
  server = await FakeYouTubeApiServer.start()
  const clock = options.clock ?? systemClock
  const logger = new RecordingLogger()
  const redactor = options.redactor ?? new SecretRedactor()
  const quota = new QuotaTracker({
    clock,
    dailyUnits: options.dailyUnits ?? 10_000,
    reserveUnits: options.reserveUnits ?? 0,
    logger,
  })
  const keys: { streamId: string; streamKey: string }[] = []
  const api = new YouTubeLiveApi({
    tokens: staticTokens,
    clock,
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
    streamKeySink: async (streamId, streamKey) => {
      keys.push({ streamId, streamKey })
    },
    baseUrl: options.baseUrl ?? server.baseUrl,
    quota,
    logger,
    redactor,
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  })
  return { api, logger, redactor, quota, keys }
}

describe('requests', () => {
  it('asks for the parts each documented method needs and authorizes every call', async () => {
    const h = await harness()

    await h.api.insertLiveStream({
      title: 'vertical-live ingest',
      description: 'vl-attempt:synthetic',
      resolution: 'variable',
      frameRate: 'variable',
      ingestionType: 'rtmp',
      isReusable: true,
    })
    await h.api.listBroadcasts({ broadcastStatus: 'upcoming' })

    expect(server?.requestsFor('liveStreams.insert')[0]?.query['part']).toBe(
      'id,snippet,cdn,contentDetails,status',
    )
    const list = server?.requestsFor('liveBroadcasts.list')[0]
    // `broadcastStatus`, `id` and `mine` are mutually exclusive; `broadcastType`
    // defaults to `event`, which would hide a persistent broadcast.
    expect(list?.query['broadcastStatus']).toBe('upcoming')
    expect(list?.query['mine']).toBeUndefined()
    expect(list?.query['broadcastType']).toBe('all')
    expect(
      server?.requests.every(
        (request) => request.authorization === 'Bearer synthetic-access-token-t10',
      ),
    ).toBe(true)
  })

  it('follows pagination and books one quota unit per page', async () => {
    const h = await harness()
    for (let index = 0; index < 51; index += 1) {
      server?.seedStream({ title: `synthetic-stream-title-${String(index)}` })
    }

    const streams = await h.api.listLiveStreams({ mine: true })

    expect(streams.items).toHaveLength(51)
    expect(streams.complete).toBe(true)
    expect(server?.requestsFor('liveStreams.list')).toHaveLength(2)
    expect(h.quota.snapshot().byMethod['liveStreams.list']).toBe(2)
  })

  it('says out loud when a list is truncated at the page bound', async () => {
    const h = await harness({ maxPages: 1 })
    for (let index = 0; index < 51; index += 1) {
      server?.seedStream({ title: `synthetic-stream-title-${String(index)}` })
    }

    const streams = await h.api.listLiveStreams({ mine: true })

    expect(streams.items).toHaveLength(50)
    // The caller is told, not just the log: "absent from a truncated list" is not
    // evidence of absence (review round 1, B2).
    expect(streams.complete).toBe(false)
    expect(h.logger.dump()).toContain('list truncated at the page bound')
  })
})

describe('failure outcomes', () => {
  it('treats a 4xx as definitely not applied', async () => {
    const h = await harness()
    server?.queueFailure('liveBroadcasts.insert', {
      status: 403,
      reason: 'liveStreamingNotEnabled',
    })

    const error = await insertBroadcast(h).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(YouTubeApiCallError)
    expect((error as YouTubeApiCallError).outcome).toBe('rejected')
    expect((error as YouTubeApiCallError).needsReconcile).toBe(false)
    expect((error as YouTubeApiCallError).reason).toBe('liveStreamingNotEnabled')
    expect((error as YouTubeApiCallError).classification.action).toBe('safe_stopped')
  })

  it('treats a 5xx as possibly applied', async () => {
    const h = await harness()
    server?.queueFailure('liveBroadcasts.bind', { status: 503, reason: 'serviceUnavailable' })

    const error = await h.api
      .bindBroadcast({ broadcastId: 'synthetic-broadcast-1', streamId: 'synthetic-stream-1' })
      .catch((caught: unknown) => caught)

    expect((error as YouTubeApiCallError).outcome).toBe('uncertain')
    expect((error as YouTubeApiCallError).needsReconcile).toBe(true)
    expect((error as YouTubeApiCallError).classification.kind).toBe('serverError')
  })

  it('treats a client-side timeout as possibly applied', async () => {
    // No wall clock anywhere in this test (review round 1, M2). The server tells us
    // the insert has been *applied*, and only then does the injected clock fire the
    // abort — so "applied but unknown" is a fact, not a race the CI can lose.
    const clock = new FakeClock()
    const h = await harness({ requestTimeoutMs: 5_000, clock })
    const hold = server?.holdApplied('liveBroadcasts.insert')

    const pending = insertBroadcast(h).catch((caught: unknown) => caught)
    await hold?.applied
    expect(server?.broadcasts.size).toBe(1)

    await clock.advance(5_000)
    const error = await pending
    hold?.release()

    expect((error as YouTubeApiCallError).outcome).toBe('uncertain')
    expect((error as YouTubeApiCallError).classification.kind).toBe('network')
    expect((error as YouTubeApiCallError).message).toContain('timed out after 5000ms')
    // The applied insert is still there: that is what makes a reconcile necessary.
    expect(server?.broadcasts.size).toBe(1)
  })

  it('treats an unreachable host as possibly applied', async () => {
    // Port 1 on loopback: nothing listens, so the connection is refused.
    const h = await harness({ baseUrl: 'http://127.0.0.1:1/youtube/v3' })

    const error = await insertBroadcast(h).catch((caught: unknown) => caught)

    expect((error as YouTubeApiCallError).outcome).toBe('uncertain')
  })

  it('never attempts a call the quota reserve is protecting', async () => {
    const h = await harness({ dailyUnits: 100, reserveUnits: 60 })

    const error = await insertBroadcast(h).catch((caught: unknown) => caught)

    expect((error as YouTubeApiCallError).outcome).toBe('not_attempted')
    expect(server?.requests).toHaveLength(0)
    // The reserve is what keeps recovery possible on a heavy day.
    await expect(h.api.listBroadcasts({ broadcastStatus: 'active' })).resolves.toEqual({
      items: [],
      complete: true,
    })
  })

  it('never attempts a call when the access token cannot be produced', async () => {
    server = await FakeYouTubeApiServer.start()
    const api = new YouTubeLiveApi({
      tokens: {
        getAccessToken: () => Promise.reject(new Error('synthetic revoked grant')),
      },
      clock: systemClock,
      requestTimeoutMs: 1_000,
      streamKeySink: async () => {},
      baseUrl: server.baseUrl,
    })

    const error = await api
      .listBroadcasts({ broadcastStatus: 'active' })
      .catch((caught: unknown) => caught)

    expect((error as YouTubeApiCallError).outcome).toBe('not_attempted')
    expect(server.requests).toHaveLength(0)
  })

  it('reports a malformed body as a shape error, without quoting it', async () => {
    const h = await harness({
      fetchFn: async () =>
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    })

    const error = await h.api
      .listBroadcasts({ broadcastStatus: 'active' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(YouTubeApiShapeError)
    expect((error as Error).message).not.toContain('html')
  })

  it("carries YouTube's own explanation of a refusal, redacted", async () => {
    // A machine reason alone is not actionable: `403 invalidTransition` says a
    // transition was refused and nothing about why. Measured twice on 2026-08-23
    // while debugging a rollover, with the same reason code for two different
    // causes.
    const h = await harness({
      fetchFn: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: 403,
                message: 'Invalid transition: the broadcast is not in a state that allows it.',
                errors: [{ reason: 'invalidTransition' }],
              },
            },
            { status: 403 },
          ),
        ),
    })

    await expect(h.api.listBroadcasts({ broadcastStatus: 'active' })).rejects.toThrow(
      /the broadcast is not in a state that allows it/,
    )
  })

  it('masks a secret that an error body quotes back at us', async () => {
    // The reason the body used to be dropped whole: a `liveStreams` failure can
    // echo the request, and that would be the stream key.
    const h = await harness()
    h.redactor.register('synthetic-stream-key-abcdef')
    const withKey = await harness({
      fetchFn: () =>
        Promise.resolve(
          Response.json(
            { error: { code: 400, message: 'bad streamName synthetic-stream-key-abcdef' } },
            { status: 400 },
          ),
        ),
      redactor: h.redactor,
    })

    const error = await withKey.api
      .listBroadcasts({ broadcastStatus: 'active' })
      .then(() => null)
      .catch((caught: unknown) => caught as Error)

    expect(error?.message).not.toContain('synthetic-stream-key-abcdef')
    expect(error?.message).toContain('bad streamName')
  })

  it('rejects an item with no id rather than inventing one', async () => {
    const h = await harness({
      fetchFn: async () =>
        Response.json({ items: [{ snippet: { title: 'synthetic' } }] }, { status: 200 }),
    })

    await expect(h.api.listBroadcasts({ broadcastStatus: 'active' })).rejects.toThrow(
      /liveBroadcast\.id is missing/,
    )
  })
})

describe('stream key handling', () => {
  it('hands the key to the sink and keeps it out of the returned summary', async () => {
    const h = await harness()

    const created = await h.api.insertLiveStream({
      title: 'vertical-live ingest',
      description: 'vl-attempt:synthetic',
      resolution: 'variable',
      frameRate: 'variable',
      ingestionType: 'rtmp',
      isReusable: true,
    })

    const stored = server?.streams.get(created.id)
    expect(h.keys).toEqual([{ streamId: created.id, streamKey: stored?.streamKey }])
    expect(created.streamKeyStored).toBe(true)
    expect(JSON.stringify(created)).not.toContain(stored?.streamKey)
    expect(created.rtmpsIngestionAddress).toBe('rtmps://synthetic.example.invalid/live2')
  })

  it('registers every key it parses with the shared redactor', async () => {
    const h = await harness()
    const first = server?.seedStream({ title: 'synthetic-a' })
    const second = server?.seedStream({ title: 'synthetic-b' })

    await h.api.listLiveStreams({ mine: true })

    expect(h.redactor.redact(`a=${first?.streamKey} b=${second?.streamKey}`)).toBe(
      'a=[redacted] b=[redacted]',
    )
  })

  it('surfaces a sink failure instead of using an unstorable stream', async () => {
    server = await FakeYouTubeApiServer.start()
    const api = new YouTubeLiveApi({
      tokens: staticTokens,
      clock: systemClock,
      requestTimeoutMs: 1_000,
      streamKeySink: () => Promise.reject(new Error('synthetic vault failure')),
      baseUrl: server.baseUrl,
    })

    await expect(
      api.insertLiveStream({
        title: 'vertical-live ingest',
        description: 'vl-attempt:synthetic',
        resolution: 'variable',
        frameRate: 'variable',
        ingestionType: 'rtmp',
        isReusable: true,
      }),
    ).rejects.toThrow(/synthetic vault failure/)
  })
})

describe('broadcast config', () => {
  it('loads the repository config with the product defaults', () => {
    const config = loadBroadcastConfig()

    expect(config.strategy).toBe('single')
    // spec §9.1: the operator publishes; §12.2: the declaration is not the gate.
    expect(config.privacyStatus).toBe('private')
    expect(config.selfDeclaredMadeForKids).toBe(false)
    // No API field sets 9:16 (see config.ts), so nothing pretends to.
    expect(config.stream.resolution).toBe('variable')
    expect(config.stream.frameRate).toBe('variable')
    expect(config.stream.ingestionType).toBe('rtmp')
    expect(config.provisional).toContain('scheduledStartLeadMs')
  })

  // Gate 2's mobile calibration needs a link a phone can open, which `private`
  // is not (BOARD D-24). The override is per-host, like every other broadcast
  // switch, and it goes through the same enumeration as the config value — a
  // typo in the environment must fail the same way a typo in the file does.
  it('takes privacyStatus from the environment when the host sets it', () => {
    expect(
      loadBroadcastConfig({ env: { VL_YOUTUBE_PRIVACY_STATUS: 'unlisted' } }).privacyStatus,
    ).toBe('unlisted')
    expect(loadBroadcastConfig({ env: {} }).privacyStatus).toBe('private')
    expect(() => loadBroadcastConfig({ env: { VL_YOUTUBE_PRIVACY_STATUS: 'friends' } })).toThrow(
      AuthConfigError,
    )
  })

  it('rejects values outside the documented enumerations', () => {
    expect(() => loadBroadcastConfig({ configPath: writeConfig({ strategy: 'rolling' }) })).toThrow(
      AuthConfigError,
    )
    expect(() =>
      loadBroadcastConfig({ configPath: writeConfig({ privacyStatus: 'friends' }) }),
    ).toThrow(AuthConfigError)
    expect(() =>
      loadBroadcastConfig({ configPath: writeConfig({ enableAutoStart: 'yes' }) }),
    ).toThrow(/must be a boolean/)
  })

  it('refuses ultra-low latency above 1080p, which YouTube documents as unsupported', () => {
    expect(() =>
      loadBroadcastConfig({
        configPath: writeConfig({ latencyPreference: 'ultraLow' }, { resolution: '1440p' }),
      }),
    ).toThrow(/ultraLow does not support/)
  })

  it('accepts the labelled rolling experiment', () => {
    const config = loadBroadcastConfig({
      configPath: writeConfig({ strategy: 'rolling-experiment' }),
    })
    expect(config.strategy).toBe('rolling-experiment')
  })
})

async function insertBroadcast(h: Harness) {
  return h.api.insertBroadcast({
    title: 'Autonomous Vertical Live',
    scheduledStartTime: '2099-01-01T00:00:00.000Z',
    privacyStatus: 'private',
    selfDeclaredMadeForKids: false,
    latencyPreference: 'ultraLow',
    enableAutoStart: false,
    enableAutoStop: false,
    enableDvr: false,
    enableMonitorStream: true,
  })
}

/** A copy of the repository config with `youtube.broadcast` overrides applied. */
function writeConfig(
  overrides: Record<string, unknown>,
  streamOverrides: Record<string, unknown> = {},
): string {
  const base = loadBroadcastConfig()
  const directory = mkdtempSync(join(tmpdir(), 'vl-broadcast-config-'))
  tempDirs.push(directory)
  const path = join(directory, 'default.json')
  writeFileSync(
    path,
    JSON.stringify({
      youtube: {
        broadcast: {
          strategy: base.strategy,
          title: base.title,
          description: base.description,
          privacyStatus: base.privacyStatus,
          selfDeclaredMadeForKids: base.selfDeclaredMadeForKids,
          latencyPreference: base.latencyPreference,
          enableAutoStart: base.enableAutoStart,
          enableAutoStop: base.enableAutoStop,
          enableDvr: base.enableDvr,
          enableMonitorStream: base.enableMonitorStream,
          scheduledStartLeadMs: base.scheduledStartLeadMs,
          requestTimeoutMs: base.requestTimeoutMs,
          autoStartWaitMs: base.autoStartWaitMs,
          healthPollIntervalMs: base.healthPollIntervalMs,
          lifecycleReconcileIntervalMs: base.lifecycleReconcileIntervalMs,
          statusPollIntervalMs: base.statusPollIntervalMs,
          transitionSettleMs: base.transitionSettleMs,
          reconcileMaxPages: base.reconcileMaxPages,
          stream: { ...base.stream, ...streamOverrides },
          provisional: base.provisional,
          ...overrides,
        },
      },
    }),
    'utf8',
  )
  return path
}
