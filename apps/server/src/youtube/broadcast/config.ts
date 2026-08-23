import {
  AuthConfigError,
  asObject,
  readPositiveInt,
  readString,
  readStringArray,
  readYouTubeSection,
  type LoadAuthConfigOptions,
} from '../auth/config.js'
import type { BroadcastStrategy } from '../../db/types.js'

/**
 * `youtube.broadcast` from `config/default.json` (spec §9.1, §9.3, §12.2).
 *
 * Note what `privacyStatus` means here: it is the privacy `BroadcastLifecycle.publish()`
 * applies as a separate, operator-triggered step. Insert is always `private`
 * (BOARD A-18).
 *
 * Only values an official page states are fixed here; everything else is listed in
 * `provisional` (BOARD A-15) and is replaced by the Gate 0/2 approved numbers.
 *
 * Two defaults are product decisions rather than tuning knobs:
 *
 * - `privacyStatus: "private"`. Spec §9.1 keeps 최초 공개 (first publication) with
 *   the operator, so the automation must never create a public broadcast on its own.
 * - `selfDeclaredMadeForKids: false`. Spec §12.2 is explicit that the declaration
 *   alone cannot avoid the classification; the evidence review before the public
 *   pilot is a human gate and this flag does not stand in for it.
 *
 * What is deliberately *not* here: any "9:16"/portrait setting. The Live Streaming
 * API has no aspect-ratio field — `cdn.resolution` is a height enum
 * (`240p`…`2160p`, `variable`) and the real frame size is whatever the encoder
 * sends (https://developers.google.com/youtube/v3/live/docs/liveStreams, checked
 * 2026-08-17). The portrait canvas is OBS's (T2/T17), so the defaults here are
 * `variable`/`variable` instead of a number that would only look authoritative.
 */

/** https://developers.google.com/youtube/v3/live/docs/liveStreams (checked 2026-08-17). */
export const STREAM_RESOLUTIONS = [
  '240p',
  '360p',
  '480p',
  '720p',
  '1080p',
  '1440p',
  '2160p',
  'variable',
] as const
export const STREAM_FRAME_RATES = ['30fps', '60fps', 'variable'] as const
/** `rtmp` covers RTMPS, per the same page. */
export const STREAM_INGESTION_TYPES = ['dash', 'hls', 'rtmp'] as const
/** https://developers.google.com/youtube/v3/live/docs/liveBroadcasts (checked 2026-08-17). */
export const BROADCAST_PRIVACY_STATUSES = ['private', 'public', 'unlisted'] as const
export const BROADCAST_LATENCY_PREFERENCES = ['normal', 'low', 'ultraLow'] as const

export type StreamResolution = (typeof STREAM_RESOLUTIONS)[number]
export type StreamFrameRate = (typeof STREAM_FRAME_RATES)[number]
export type StreamIngestionType = (typeof STREAM_INGESTION_TYPES)[number]
export type BroadcastPrivacyStatus = (typeof BROADCAST_PRIVACY_STATUSES)[number]
export type BroadcastLatencyPreference = (typeof BROADCAST_LATENCY_PREFERENCES)[number]

export interface IngestionStreamConfig {
  /** Stable title: it is the reuse and reconcile key for `liveStreams`. */
  readonly title: string
  readonly resolution: StreamResolution
  readonly frameRate: StreamFrameRate
  readonly ingestionType: StreamIngestionType
  /** `contentDetails.isReusable`; a reusable stream survives a rollover. */
  readonly isReusable: boolean
}

export interface BroadcastConfig {
  /** BOARD A-4: `single` is production, `rolling-experiment` is labelled. */
  readonly strategy: BroadcastStrategy
  readonly title: string
  /**
   * The operator's description text. An empty string is *not* "send no description":
   * the insert always sends one, because the attempt marker travels in it (review
   * round 2, B1) and is removed again once the broadcast id is durable (BOARD A-18).
   */
  readonly description: string
  /**
   * The privacy `publish()` applies. The **insert always creates the broadcast
   * `private`** whatever this says: spec §9.1 keeps first publication with the
   * operator, and nothing may be viewer-visible while the attempt marker is still in
   * the description (BOARD A-18).
   */
  readonly privacyStatus: BroadcastPrivacyStatus
  readonly selfDeclaredMadeForKids: boolean
  readonly latencyPreference: BroadcastLatencyPreference
  /**
   * `contentDetails.enableAutoStart`. **Off**, and the default is off for a
   * measured reason (2026-08-23, TASK_SPECS §T38).
   *
   * Auto-start fires "when you start streaming video on the bound live stream"
   * — an *event*. On a host that restarts, the encoder is often already pushing
   * when the broadcast is bound, so that edge never happens and the flag does
   * nothing: the start-up sequence waited out `autoStartWaitMs` and gave up.
   *
   * Worse, a broadcast created with it on **refuses a manual transition**:
   * `liveBroadcasts.transition` to `testing` answered `invalidTransition` 403,
   * which is what left the run stuck at `bound` and the host unable to
   * broadcast. So the fallback path the code has for "auto-start did not fire"
   * could not work either.
   *
   * With it off there is one path to `live` and it is the one measured to work:
   * `ready → testing → live`, waiting for each transition to settle.
   */
  readonly enableAutoStart: boolean
  readonly enableAutoStop: boolean
  readonly enableDvr: boolean
  readonly enableMonitorStream: boolean
  /** How far ahead of "now" `snippet.scheduledStartTime` is placed. */
  readonly scheduledStartLeadMs: number
  readonly requestTimeoutMs: number
  /** How long auto-start is given before the transition fallback runs. */
  readonly autoStartWaitMs: number
  readonly statusPollIntervalMs: number
  /**
   * How long a transition is given to leave its in-flight state (`testStarting`,
   * `liveStarting`) before the caller stops waiting. The reference says such a
   * transition "may take several seconds, or even up to a minute"
   * (`life-of-a-broadcast` 3.4, checked 2026-08-23), so this is that minute.
   */
  readonly transitionSettleMs: number
  /** Bound on `list` pagination while reconciling. */
  readonly reconcileMaxPages: number
  /**
   * How long one broadcast segment runs before it is replaced (BOARD `D-21`).
   * `null` turns rollover off, which is the default: CI and development hosts
   * must not replace broadcasts, and a run that never rolls over is the shape
   * every test before T33 assumed.
   *
   * Spec §9.3 is why the number matters: past twelve hours a broadcast may leave
   * **no archive at all**, and without a VOD its watch time is excluded from YPP.
   * D-21 chose 11h — under the limit, with an hour of room for the swap.
   */
  readonly segmentMs: number | null
  readonly stream: IngestionStreamConfig
  readonly provisional: readonly string[]
}

export function loadBroadcastConfig(options: LoadAuthConfigOptions = {}): BroadcastConfig {
  const section = readYouTubeSection('broadcast', options)
  const stream = asObject(section['stream'], 'youtube.broadcast.stream')
  const env = options.env ?? process.env

  const strategy = readEnum(section['strategy'], 'youtube.broadcast.strategy', [
    'single',
    'rolling-experiment',
  ] as const)
  const enableDvr = readBoolean(section['enableDvr'], 'youtube.broadcast.enableDvr')
  const latencyPreference = readEnum(
    section['latencyPreference'],
    'youtube.broadcast.latencyPreference',
    BROADCAST_LATENCY_PREFERENCES,
  )
  const resolution = readEnum(
    stream['resolution'],
    'youtube.broadcast.stream.resolution',
    STREAM_RESOLUTIONS,
  )
  // The one documented incompatibility: ultra-low latency "does not support closed
  // captions, or resolutions higher than 1080p"
  // (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts, checked
  // 2026-08-17). Refused here rather than as `invalidLatencyPreferenceOptions` at
  // insert time, where the operator would not see which two values disagree.
  // Nothing is claimed about DVR: that page states no ultra-low/DVR restriction.
  if (latencyPreference === 'ultraLow' && (resolution === '1440p' || resolution === '2160p')) {
    throw new AuthConfigError(
      `youtube.broadcast.stream.resolution ${resolution} is above 1080p, which latencyPreference ultraLow does not support`,
    )
  }

  return Object.freeze({
    strategy,
    title: readString(section['title'], 'youtube.broadcast.title'),
    description: readOptionalString(section['description'], 'youtube.broadcast.description'),
    // `VL_YOUTUBE_PRIVACY_STATUS` overrides it for one host, the way every other
    // broadcast switch works. The default stays `private` — spec §9.1 keeps first
    // publication with the operator (BOARD A-18), and a default that exposes a
    // broadcast is a default nobody chose. Gate 2's calibration is what needs
    // `unlisted`: a private broadcast cannot be opened on a phone, and unlisted
    // is visible to a link without entering search, recommendations or the
    // vertical feed (BOARD D-24).
    privacyStatus: readEnum(
      env['VL_YOUTUBE_PRIVACY_STATUS'] ?? section['privacyStatus'],
      'youtube.broadcast.privacyStatus',
      BROADCAST_PRIVACY_STATUSES,
    ),
    selfDeclaredMadeForKids: readBoolean(
      section['selfDeclaredMadeForKids'],
      'youtube.broadcast.selfDeclaredMadeForKids',
    ),
    latencyPreference,
    enableAutoStart: readBoolean(section['enableAutoStart'], 'youtube.broadcast.enableAutoStart'),
    enableAutoStop: readBoolean(section['enableAutoStop'], 'youtube.broadcast.enableAutoStop'),
    enableDvr,
    enableMonitorStream: readBoolean(
      section['enableMonitorStream'],
      'youtube.broadcast.enableMonitorStream',
    ),
    segmentMs:
      section['segmentMs'] === null || section['segmentMs'] === undefined
        ? null
        : readPositiveInt(section['segmentMs'], 'youtube.broadcast.segmentMs'),
    scheduledStartLeadMs: readPositiveInt(
      section['scheduledStartLeadMs'],
      'youtube.broadcast.scheduledStartLeadMs',
    ),
    requestTimeoutMs: readPositiveInt(
      section['requestTimeoutMs'],
      'youtube.broadcast.requestTimeoutMs',
    ),
    autoStartWaitMs: readPositiveInt(
      section['autoStartWaitMs'],
      'youtube.broadcast.autoStartWaitMs',
    ),
    transitionSettleMs: readPositiveInt(
      section['transitionSettleMs'],
      'youtube.broadcast.transitionSettleMs',
    ),
    statusPollIntervalMs: readPositiveInt(
      section['statusPollIntervalMs'],
      'youtube.broadcast.statusPollIntervalMs',
    ),
    reconcileMaxPages: readPositiveInt(
      section['reconcileMaxPages'],
      'youtube.broadcast.reconcileMaxPages',
    ),
    stream: Object.freeze({
      title: readString(stream['title'], 'youtube.broadcast.stream.title'),
      resolution,
      frameRate: readEnum(
        stream['frameRate'],
        'youtube.broadcast.stream.frameRate',
        STREAM_FRAME_RATES,
      ),
      ingestionType: readEnum(
        stream['ingestionType'],
        'youtube.broadcast.stream.ingestionType',
        STREAM_INGESTION_TYPES,
      ),
      isReusable: readBoolean(stream['isReusable'], 'youtube.broadcast.stream.isReusable'),
    }),
    provisional: Object.freeze(
      readStringArray(section['provisional'], 'youtube.broadcast.provisional'),
    ),
  })
}

/** True when the configured strategy is the labelled experiment (spec §9.3). */
export function isExperimentalStrategy(strategy: BroadcastStrategy): boolean {
  return strategy === 'rolling-experiment'
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new AuthConfigError(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value as T[number]
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AuthConfigError(`${label} must be a boolean`)
  }
  return value
}

function readOptionalString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AuthConfigError(`${label} must be a string (empty means "omit")`)
  }
  return value
}
