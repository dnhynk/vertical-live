import { systemClock, type Clock } from '../../clock.js'
import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import type { HealthSignal } from '../../health/types.js'
import { InMemorySecretVault } from '../../secrets/memory.js'
import { SecretRedactor, type LogFields, type Logger } from '../../secrets/redaction.js'
import { FakeYouTubeApiServer } from '../../testing/fake-youtube-api-server.js'
import type { BackoffPolicy } from '../quota/backoff.js'
import { QuotaTracker } from '../quota/tracker.js'
import { YouTubeLiveApi, type AccessTokenSource } from './api.js'
import { RecordingBroadcastAlertSink, type SafeStopRequest } from './alerts.js'
import type { BroadcastConfig } from './config.js'
import { BroadcastLifecycle } from './lifecycle.js'
import { StreamKeyCustodian } from './stream-key.js'

/**
 * Wiring shared by the T10 tests: the fake API server, a temporary on-disk store, an
 * in-memory vault and a logger that keeps every line so a test can assert that no
 * stream key was ever written anywhere (acceptance 2).
 *
 * The clock is the *system* clock on purpose. The behaviour under test is a real
 * client-side timeout against a real socket, so the abort has to be driven by real
 * time; the delays involved are tens of milliseconds.
 */

export const SYNTHETIC_ACCESS_TOKEN = 'synthetic-access-token-t10'

export interface RecordedLog {
  readonly level: keyof Logger
  readonly message: string
  readonly fields: LogFields | undefined
}

export class RecordingLogger implements Logger {
  readonly lines: RecordedLog[] = []

  debug(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'debug', message, fields })
  }
  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', message, fields })
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', message, fields })
  }
  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', message, fields })
  }

  /** Everything that was logged, as one blob, for substring assertions. */
  dump(): string {
    return this.lines
      .map((line) => `${line.level} ${line.message} ${JSON.stringify(line.fields ?? {})}`)
      .join('\n')
  }
}

/** Deterministic: no jitter, no waiting. Retry counts stay explicit in the tests. */
export function testBackoff(maxAttempts = 2): BackoffPolicy {
  return { maxAttempts, nextDelayMs: () => 0 }
}

export const TEST_BROADCAST_CONFIG: BroadcastConfig = Object.freeze({
  strategy: 'single',
  // Rollover off unless a test asks for it, which is the product default too.
  segmentMs: null,
  transitionSettleMs: 90_000,
  title: 'Autonomous Vertical Live',
  description: '',
  privacyStatus: 'private',
  selfDeclaredMadeForKids: false,
  latencyPreference: 'ultraLow',
  enableAutoStart: false,
  enableAutoStop: false,
  enableDvr: false,
  enableMonitorStream: true,
  scheduledStartLeadMs: 120_000,
  requestTimeoutMs: 2_000,
  autoStartWaitMs: 40,
  statusPollIntervalMs: 20,
  reconcileMaxPages: 4,
  stream: Object.freeze({
    title: 'vertical-live ingest',
    resolution: 'variable',
    frameRate: 'variable',
    ingestionType: 'rtmp',
    isReusable: true,
  }),
  provisional: Object.freeze([]),
})

export const staticTokens: AccessTokenSource = {
  getAccessToken: async () => SYNTHETIC_ACCESS_TOKEN,
}

export interface BroadcastHarness {
  readonly server: FakeYouTubeApiServer
  readonly temp: TempStore
  readonly vault: InMemorySecretVault
  readonly logger: RecordingLogger
  readonly redactor: SecretRedactor
  readonly custodian: StreamKeyCustodian
  readonly api: YouTubeLiveApi
  readonly quota: QuotaTracker
  readonly config: BroadcastConfig
  readonly alerts: RecordingBroadcastAlertSink
  readonly safeStops: SafeStopRequest[]
  lifecycle(): BroadcastLifecycle
  /** Rebuilds the lifecycle over a reopened store, as a restart would. */
  restart(): BroadcastLifecycle
  dispose(): Promise<void>
}

export interface HarnessOptions {
  readonly config?: Partial<BroadcastConfig>
  readonly clock?: Clock
  readonly maxAttempts?: number
  readonly quotaOptions?: { readonly dailyUnits?: number; readonly reserveUnits?: number }
  readonly signals?: HealthSignal[]
}

export async function createBroadcastHarness(
  options: HarnessOptions = {},
): Promise<BroadcastHarness> {
  const server = await FakeYouTubeApiServer.start()
  const clock = options.clock ?? systemClock
  const temp = createTempStore({ clock })
  const vault = new InMemorySecretVault()
  const logger = new RecordingLogger()
  const redactor = new SecretRedactor()
  const custodian = new StreamKeyCustodian({ vault, redactor, logger })
  const quota = new QuotaTracker({
    clock,
    dailyUnits: options.quotaOptions?.dailyUnits ?? 10_000,
    reserveUnits: options.quotaOptions?.reserveUnits ?? 0,
    logger,
  })
  const config: BroadcastConfig = Object.freeze({
    ...TEST_BROADCAST_CONFIG,
    ...options.config,
    stream: Object.freeze({ ...TEST_BROADCAST_CONFIG.stream, ...options.config?.stream }),
  })
  const api = new YouTubeLiveApi({
    tokens: staticTokens,
    clock,
    requestTimeoutMs: config.requestTimeoutMs,
    streamKeySink: custodian.sink,
    baseUrl: server.baseUrl,
    quota,
    logger,
    redactor,
  })
  const alerts = new RecordingBroadcastAlertSink()
  const safeStops: SafeStopRequest[] = []

  let serial = 0
  const build = (): BroadcastLifecycle =>
    new BroadcastLifecycle({
      api,
      store: temp.store,
      config,
      clock,
      backoff: testBackoff(options.maxAttempts ?? 2),
      streamKeys: custodian,
      alerts: alerts.sink,
      safeStop: (request) => safeStops.push(request),
      logger,
      newAttemptId: () => {
        serial += 1
        return `attempt-${String(serial).padStart(4, '0')}`
      },
    })

  return {
    server,
    temp,
    vault,
    logger,
    redactor,
    custodian,
    api,
    quota,
    config,
    alerts,
    safeStops,
    lifecycle: build,
    restart() {
      temp.reopen()
      return build()
    },
    async dispose() {
      temp.dispose()
      await server.stop()
    },
  }
}
