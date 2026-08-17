import {
  CONTRACT_VERSION,
  type CommandName,
  type Effect,
  type IngestEnvelope,
  type WorldSnapshot,
} from '@vl/contract'

import type { Clock } from '../../clock.js'
import type { PersistenceStore } from '../../db/store.js'
import { createTempStore, type TempStore } from '../../db/testing/temp-store.js'
import { loadInputConfig, type InputConfig } from '../../input/config.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { loadEngineConfig, type EngineRuntimeConfig } from '../config.js'
import { StateEngine, type EnginePublisher } from '../engine.js'
import type { InboxWriter } from '../ingest.js'

/**
 * Test harness for the state engine.
 *
 * Everything is synthetic and obviously so (spec §2.6): ids are `msg_test_*`,
 * the source is `simulator`, and no fixture carries an author, a display name or
 * a chat line — the contract has no field for them.
 *
 * The clock is a `FakeClock` and `autoTick` is off, so every test drives the
 * writer loop explicitly: nothing in these tests depends on real elapsed time.
 */

export const TEST_BROADCAST_ID = 'brd_test_engine'
export const TEST_LIVE_CHAT_ID = 'chat_test_engine'
export const TEST_EPOCH_MS = Date.UTC(2026, 7, 16, 0, 0, 0)

/** Records what the engine published and reports a settable renderer count. */
export class RecordingPublisher implements EnginePublisher {
  rendererCount: number
  /** Makes the next publish throw, standing in for a pass-level failure. */
  failNextPublish = false
  readonly snapshots: WorldSnapshot[] = []
  readonly effects: Effect[] = []

  constructor(rendererCount = 1) {
    this.rendererCount = rendererCount
  }

  publishSnapshot(snapshot: WorldSnapshot): void {
    if (this.failNextPublish) throw new Error('publish failed')
    this.snapshots.push(snapshot)
  }

  publishEffect(effect: Effect): void {
    if (this.failNextPublish) throw new Error('publish failed')
    this.effects.push(effect)
  }

  get lastSnapshot(): WorldSnapshot | undefined {
    return this.snapshots.at(-1)
  }

  /** Distinct effect ids, i.e. what a renderer would actually have played. */
  get uniqueEffectIds(): string[] {
    return [...new Set(this.effects.map((effect) => effect.effectId))]
  }
}

export interface HarnessOptions {
  readonly clock?: FakeClock
  readonly publisher?: RecordingPublisher
  readonly config?: EngineRuntimeConfig
  readonly inputConfig?: InputConfig
  /** Reuse an existing store/directory, as a restart would. */
  readonly temp?: TempStore
}

export interface EngineHarness {
  readonly engine: StateEngine
  readonly store: PersistenceStore
  readonly clock: FakeClock
  readonly publisher: RecordingPublisher
  readonly temp: TempStore
  readonly config: EngineRuntimeConfig
  dispose(): void
}

let cachedConfig: EngineRuntimeConfig | undefined
let cachedInputConfig: InputConfig | undefined

/** The repository configuration, loaded once per test process. */
export function testEngineConfig(): EngineRuntimeConfig {
  cachedConfig ??= loadEngineConfig({ env: {} })
  return cachedConfig
}

export function testInputConfig(): InputConfig {
  cachedInputConfig ??= loadInputConfig({ env: {} })
  return cachedInputConfig
}

export function withEngineConfig(
  overrides: (config: EngineRuntimeConfig) => EngineRuntimeConfig,
): EngineRuntimeConfig {
  return overrides(testEngineConfig())
}

export function createEngineHarness(options: HarnessOptions = {}): EngineHarness {
  const clock = options.clock ?? new FakeClock({ epochMs: TEST_EPOCH_MS })
  const temp = options.temp ?? createTempStore({ clock })
  const publisher = options.publisher ?? new RecordingPublisher()
  const config = options.config ?? testEngineConfig()
  const engine = new StateEngine({
    store: temp.store,
    clock,
    config,
    inputConfig: options.inputConfig ?? testInputConfig(),
    publisher,
    autoTick: false,
  })
  return {
    engine,
    store: temp.store,
    clock,
    publisher,
    temp,
    config,
    dispose: () => {
      engine.stop()
      if (options.temp === undefined) temp.dispose()
    },
  }
}

/** A restart against the same database file (spec §11 상태 복구). */
export function restartEngine(harness: EngineHarness, options: HarnessOptions = {}): EngineHarness {
  harness.engine.stop()
  harness.temp.reopen()
  return createEngineHarness({ ...options, temp: harness.temp, clock: harness.clock })
}

// ---------------------------------------------------------------- envelopes

let messageCounter = 0

export function nextMessageId(prefix = 'msg_test'): string {
  messageCounter += 1
  return `${prefix}_${String(messageCounter).padStart(4, '0')}`
}

export function resetMessageIds(): void {
  messageCounter = 0
}

interface EnvelopeBase {
  readonly messageId?: string
  readonly receivedAt: string
  readonly occurredAt?: string
}

export function commandEnvelope(
  options: EnvelopeBase & { readonly command: CommandName; readonly argument?: string | null },
): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'simulator',
    source: 'simulator',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt: options.receivedAt,
    messageId: options.messageId ?? nextMessageId('msg_test_cmd'),
    validationStatus: 'valid',
    kind: 'CHAT_COMMAND',
    occurredAt: options.occurredAt ?? options.receivedAt,
    command: { name: options.command, argument: options.argument ?? null },
    payment: null,
  }
}

export function superChatEnvelope(
  options: EnvelopeBase & { readonly amountMicros?: number; readonly tier?: number },
): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'simulator',
    source: 'simulator',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt: options.receivedAt,
    messageId: options.messageId ?? nextMessageId('msg_test_sc'),
    validationStatus: 'valid',
    kind: 'SUPER_CHAT',
    occurredAt: options.occurredAt ?? options.receivedAt,
    command: null,
    payment: {
      amountMicros: options.amountMicros ?? 500_000,
      currency: 'JPY',
      tier: options.tier ?? 1,
      jewels: null,
      comboCount: null,
      giftName: null,
    },
  }
}

export function giftEnvelope(
  options: EnvelopeBase & { readonly comboCount: number; readonly jewels?: number },
): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'simulator',
    source: 'simulator',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt: options.receivedAt,
    messageId: options.messageId ?? nextMessageId('msg_test_gift'),
    validationStatus: 'valid',
    kind: 'GIFT',
    occurredAt: options.occurredAt ?? options.receivedAt,
    command: null,
    payment: {
      amountMicros: null,
      currency: null,
      tier: null,
      jewels: options.jewels ?? 10,
      comboCount: options.comboCount,
      giftName: 'test_gift',
    },
  }
}

export function invalidEnvelope(options: EnvelopeBase): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'simulator',
    source: 'simulator',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt: options.receivedAt,
    messageId: options.messageId ?? nextMessageId('msg_test_bad'),
    validationStatus: 'invalid',
    validationError: { code: 'MALFORMED_ITEM', field: 'snippet', sourceMessageType: null },
  }
}

export function unsupportedEnvelope(options: EnvelopeBase): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'simulator',
    source: 'simulator',
    broadcastId: TEST_BROADCAST_ID,
    liveChatId: TEST_LIVE_CHAT_ID,
    receivedAt: options.receivedAt,
    messageId: options.messageId ?? nextMessageId('msg_test_unsup'),
    validationStatus: 'unsupported',
    validationError: {
      code: 'UNSUPPORTED_MESSAGE_TYPE',
      field: 'snippet.type',
      sourceMessageType: 'sponsorOnlyModeStartedEvent',
    },
  }
}

export const TEST_CHECKPOINT = {
  sourceKey: `simulator:${TEST_LIVE_CHAT_ID}`,
  liveChatId: TEST_LIVE_CHAT_ID,
  nextPageToken: null,
}

/**
 * Commits envelopes the way a source adapter will (spec §7.3(2)) — through the
 * engine, so every test goes past the storage-boundary argument sanitizer rather
 * than around it (R-T8-1 blocker 4).
 */
export function ingest(inbox: InboxWriter, envelopes: readonly IngestEnvelope[]): void {
  inbox.ingest(envelopes, TEST_CHECKPOINT)
}

/** ISO instant `millis` after the harness epoch. */
export function at(millis: number, clock?: Clock): string {
  void clock
  return new Date(TEST_EPOCH_MS + millis).toISOString()
}
