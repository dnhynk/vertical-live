import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { CHANNEL_REF_PATTERN, CONTRACT_VERSION, type IngestEnvelope } from '@vl/contract'
import { afterEach, describe, expect, it } from 'vitest'

import { createRetentionHarness, type RetentionHarness } from '../privacy/testing/harness.js'
import type { LogFields } from '../secrets/redaction.js'
import {
  readAuthorIdentity,
  readGrpcAuthorIdentity,
  readRestAuthorIdentity,
} from './author-details.js'
import { ConsentDirectory, issueChannelRef } from './directory.js'
import { CONSENT_NOTICE_VERSION } from './notice.js'

/**
 * The consent directory of BOARD D-9 (TASK_SPECS §T20b).
 *
 * Every value in this file is obviously synthetic (spec §2.6): channel ids are
 * `UC_TEST_…` and names are `synthetic-viewer-N`. Nothing here resembles a real
 * viewer, and the assertions are mostly about what does **not** appear anywhere.
 */

const T0 = '2026-01-01T00:00:00.000Z'
const VIEWER_ONE = 'UC_TEST_synthetic_viewer_1'
const NAME_ONE = 'synthetic-viewer-1'
const NOTICE_DOC = new URL('../../../../docs/ops/identity-consent.md', import.meta.url)

let harness: RetentionHarness | undefined

afterEach(() => {
  harness?.dispose()
  harness = undefined
})

interface CapturedLog {
  readonly line: string
}

function open(): { active: RetentionHarness; directory: ConsentDirectory; logs: CapturedLog[] } {
  harness = createRetentionHarness()
  const active = harness
  const logs: CapturedLog[] = []
  const record = (message: string, fields?: LogFields): void => {
    logs.push({ line: `${message} ${JSON.stringify(fields ?? {})}` })
  }
  const directory = new ConsentDirectory({
    store: active.store,
    clock: active.clock,
    retention: active.config,
    logger: { debug: record, info: record, warn: record, error: record },
  })
  return { active, directory, logs }
}

/** A gRPC `streamList` item, optionally carrying `author_details` ([S4] proto). */
function grpcItem(options: {
  readonly messageId: string
  readonly text?: string
  readonly channelId?: string
  readonly displayName?: string
}): unknown {
  return {
    id: options.messageId,
    snippet: {
      type: 'TEXT_MESSAGE_EVENT',
      live_chat_id: 'chat_test_identity',
      published_at: T0,
      text_message_details: { message_text: options.text ?? 'ごはん' },
    },
    ...(options.channelId === undefined
      ? {}
      : {
          author_details: {
            channel_id: options.channelId,
            display_name: options.displayName ?? NAME_ONE,
            profile_image_url: 'https://example.invalid/avatar_test.png',
          },
        }),
  }
}

function envelope(options: {
  readonly messageId: string
  readonly consent?: 'JOIN' | 'LEAVE'
}): IngestEnvelope {
  return {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'grpc',
    source: 'youtube',
    broadcastId: 'brd_test_identity',
    liveChatId: 'chat_test_identity',
    receivedAt: T0,
    messageId: options.messageId,
    validationStatus: 'valid',
    kind: 'CHAT_COMMAND',
    occurredAt: T0,
    command: options.consent === undefined ? { name: 'FEED', argument: null } : null,
    ...(options.consent === undefined
      ? {}
      : { consentCommand: { name: options.consent, argument: null } }),
    payment: null,
  }
}

describe('authorDetails readers', () => {
  it('reads the gRPC snake_case spelling and the REST camelCase one, never mixed', () => {
    // Spec §7.2: "gRPC proto와 REST resource의 필드명을 섞지 않고".
    const grpc = { author_details: { channel_id: VIEWER_ONE, display_name: NAME_ONE } }
    const rest = { authorDetails: { channelId: VIEWER_ONE, displayName: NAME_ONE } }

    expect(readGrpcAuthorIdentity(grpc)).toEqual({ channelId: VIEWER_ONE, displayName: NAME_ONE })
    expect(readRestAuthorIdentity(rest)).toEqual({ channelId: VIEWER_ONE, displayName: NAME_ONE })
    expect(readGrpcAuthorIdentity(rest)).toBeNull()
    expect(readRestAuthorIdentity(grpc)).toBeNull()
  })

  it('reads nothing for the simulator shape', () => {
    // The simulator may not invent participation (spec §2.6), so it has no author
    // vocabulary of its own to borrow.
    const item = { author_details: { channel_id: VIEWER_ONE, display_name: NAME_ONE } }
    expect(readAuthorIdentity(item, 'simulator')).toBeNull()
    expect(readAuthorIdentity(item, 'grpc')).not.toBeNull()
  })

  it('refuses half an identity and a name that could carry a second line', () => {
    expect(readGrpcAuthorIdentity({ author_details: { channel_id: VIEWER_ONE } })).toBeNull()
    expect(readGrpcAuthorIdentity({ author_details: { display_name: NAME_ONE } })).toBeNull()
    expect(
      readGrpcAuthorIdentity({
        author_details: { channel_id: VIEWER_ONE, display_name: 'line one\nline two' },
      }),
    ).toBeNull()
    expect(
      readGrpcAuthorIdentity({
        author_details: { channel_id: 'not a channel id', display_name: NAME_ONE },
      }),
    ).toBeNull()
  })
})

describe('channel references', () => {
  it('issues opaque references that match the contract pattern', () => {
    const refs = Array.from({ length: 50 }, () => issueChannelRef())
    for (const ref of refs) expect(ref).toMatch(CHANNEL_REF_PATTERN)
    // Random, not derived: 50 draws of 128 bits collide with probability ~0.
    expect(new Set(refs).size).toBe(50)
  })

  it('is not derived from the channel id it points at', () => {
    // §12.4 forbids a reversible or stable hash just as firmly as the id itself,
    // so the same viewer joining twice from an empty store gets different refs.
    const { directory, active } = open()
    directory.observe(
      grpcItem({ messageId: 'msg_test_j1', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_j1', consent: 'JOIN' }),
    )
    const first = active.store.findConsentByChannelId(VIEWER_ONE)?.channelRef
    directory.forget({ channelId: VIEWER_ONE }, 'user_request')
    directory.observe(
      grpcItem({ messageId: 'msg_test_j2', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_j2', consent: 'JOIN' }),
    )
    const second = active.store.findConsentByChannelId(VIEWER_ONE)?.channelRef

    expect(first).toMatch(CHANNEL_REF_PATTERN)
    expect(second).toMatch(CHANNEL_REF_PATTERN)
    expect(second).not.toBe(first)
  })
})

describe('ConsentDirectory', () => {
  it('records consent on JOIN and stores exactly the six declared columns', () => {
    const { directory, active } = open()

    const observation = directory.observe(
      grpcItem({ messageId: 'msg_test_join', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_join', consent: 'JOIN' }),
    )

    expect(observation).toEqual({ kind: 'joined', renewed: false })
    const stored = active.store.findConsentByChannelId(VIEWER_ONE)
    expect(stored).toEqual({
      channelRef: expect.stringMatching(CHANNEL_REF_PATTERN) as unknown as string,
      channelId: VIEWER_ONE,
      displayName: NAME_ONE,
      consentedAt: active.clock.nowUtcIso(),
      lastActiveAt: active.clock.nowUtcIso(),
      noticeVersion: CONSENT_NOTICE_VERSION,
    })
  })

  it('renews consent on a second JOIN without re-rolling the reference', () => {
    const { directory, active } = open()
    directory.observe(
      grpcItem({ messageId: 'msg_test_join', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_join', consent: 'JOIN' }),
    )
    const first = active.store.findConsentByChannelId(VIEWER_ONE)?.channelRef

    const observation = directory.observe(
      grpcItem({ messageId: 'msg_test_join2', channelId: VIEWER_ONE, displayName: 'renamed-1' }),
      envelope({ messageId: 'msg_test_join2', consent: 'JOIN' }),
    )

    expect(observation).toEqual({ kind: 'joined', renewed: true })
    expect(active.store.findConsentByChannelId(VIEWER_ONE)?.channelRef).toBe(first)
    expect(active.store.findConsentByChannelId(VIEWER_ONE)?.displayName).toBe('renamed-1')
    expect(active.store.countRows('viewer_consent')).toBe(1)
  })

  it('attributes a consented viewer once per message and refreshes the record', () => {
    const { directory, active } = open()
    directory.observe(
      grpcItem({ messageId: 'msg_test_join', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_join', consent: 'JOIN' }),
    )
    const ref = active.store.findConsentByChannelId(VIEWER_ONE)?.channelRef

    active.clock.advance(60_000)
    const observation = directory.observe(
      grpcItem({ messageId: 'msg_test_feed', channelId: VIEWER_ONE, displayName: 'renamed-1' }),
      envelope({ messageId: 'msg_test_feed' }),
    )

    expect(observation).toEqual({ kind: 'attributed' })
    // [S41] III.E.4.c: the message is the refresh, so both columns are rewritten.
    expect(active.store.findConsentByChannelId(VIEWER_ONE)).toMatchObject({
      displayName: 'renamed-1',
      lastActiveAt: active.clock.nowUtcIso(),
    })
    expect(directory.takeActor('msg_test_feed')).toEqual({
      kind: 'consented',
      displayName: 'renamed-1',
      channelRef: ref,
    })
    // Taken once: a message produces one reaction.
    expect(directory.takeActor('msg_test_feed')).toBeNull()
    expect(directory.pendingCount).toBe(0)
  })

  it('deletes the record on LEAVE, immediately and with an audit row', () => {
    const { directory, active } = open()
    directory.observe(
      grpcItem({ messageId: 'msg_test_join', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_join', consent: 'JOIN' }),
    )
    directory.observe(
      grpcItem({ messageId: 'msg_test_feed', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_feed' }),
    )
    expect(directory.pendingCount).toBe(1)

    const observation = directory.observe(
      grpcItem({ messageId: 'msg_test_leave', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_leave', consent: 'LEAVE' }),
    )

    expect(observation).toEqual({ kind: 'left', deleted: true })
    expect(active.store.findConsentByChannelId(VIEWER_ONE)).toBeNull()
    expect(active.store.countRows('viewer_consent')).toBe(0)
    // A message received a moment before the withdrawal must not still put the
    // name on screen (D-9 "철회/삭제 명령으로 즉시 삭제").
    expect(directory.takeActor('msg_test_feed')).toBeNull()
    expect(directory.pendingCount).toBe(0)

    const ledger = active.store.listRetentionLedger({ reason: 'consent_revoked' })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      fieldKey: 'viewer_consent.identity',
      outcome: 'deleted',
      rowsDeleted: 1,
      allowedPeriodDays: 7,
    })
  })

  it('records a LEAVE from a viewer who never joined without claiming a deletion', () => {
    const { directory, active } = open()
    const observation = directory.observe(
      grpcItem({ messageId: 'msg_test_leave', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_leave', consent: 'LEAVE' }),
    )
    expect(observation).toEqual({ kind: 'left', deleted: false })
    expect(active.store.listRetentionLedger({ reason: 'consent_revoked' })[0]).toMatchObject({
      outcome: 'no_stored_identifiers',
      rowsDeleted: 0,
      deletedAt: null,
    })
  })

  it('drops the authorDetails of a viewer who never consented', () => {
    const { directory, active } = open()

    const observation = directory.observe(
      grpcItem({ messageId: 'msg_test_anon', channelId: 'UC_TEST_synthetic_viewer_9' }),
      envelope({ messageId: 'msg_test_anon' }),
    )

    expect(observation).toEqual({ kind: 'anonymous' })
    expect(active.store.countRows('viewer_consent')).toBe(0)
    expect(directory.takeActor('msg_test_anon')).toBeNull()
    expect(directory.pendingCount).toBe(0)
  })

  it('ignores an item with no author part at all (the closed-mode response)', () => {
    const { directory, active } = open()
    const observation = directory.observe(
      grpcItem({ messageId: 'msg_test_join', text: 'なのる' }),
      envelope({ messageId: 'msg_test_join', consent: 'JOIN' }),
    )
    expect(observation).toEqual({ kind: 'anonymous' })
    expect(active.store.countRows('viewer_consent')).toBe(0)
  })

  it('never writes a name or a channel id into a log line', () => {
    // Spec §12.3/§12.4: the observation type carries counts and outcomes only.
    const { directory, logs } = open()
    directory.observe(
      grpcItem({ messageId: 'msg_test_join', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_join', consent: 'JOIN' }),
    )
    directory.observe(
      grpcItem({ messageId: 'msg_test_feed', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_feed' }),
    )
    directory.observe(
      grpcItem({ messageId: 'msg_test_leave', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_leave', consent: 'LEAVE' }),
    )

    const text = logs.map((entry) => entry.line).join('\n')
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain(VIEWER_ONE)
    expect(text).not.toContain(NAME_ONE)
    expect(text).not.toMatch(/ref_[0-9a-f]{32}/)
  })

  it('bounds the in-memory attribution buffer', () => {
    harness = createRetentionHarness()
    const active = harness
    const directory = new ConsentDirectory({
      store: active.store,
      clock: active.clock,
      retention: active.config,
      pendingLimit: 3,
    })
    directory.observe(
      grpcItem({ messageId: 'msg_test_join', channelId: VIEWER_ONE }),
      envelope({ messageId: 'msg_test_join', consent: 'JOIN' }),
    )
    for (let index = 0; index < 5; index += 1) {
      const messageId = `msg_test_feed_${String(index)}`
      directory.observe(grpcItem({ messageId, channelId: VIEWER_ONE }), envelope({ messageId }))
    }

    expect(directory.pendingCount).toBe(3)
    // The oldest were evicted: their reactions are shown without a name, which is
    // the same outcome as a restart and never a wrong name.
    expect(directory.takeActor('msg_test_feed_0')).toBeNull()
    expect(directory.takeActor('msg_test_feed_4')).not.toBeNull()
  })

  it('refuses to start without a retention schedule for the consent field', () => {
    harness = createRetentionHarness()
    const active = harness
    const withoutConsent = {
      ...active.config,
      fields: active.config.fields.filter((field) => field.key !== 'viewer_consent.identity'),
    }
    expect(
      () =>
        new ConsentDirectory({
          store: active.store,
          clock: active.clock,
          retention: withoutConsent,
        }),
    ).toThrow(/no viewer_consent\.identity field/)
  })
})

describe('the consent notice', () => {
  it('is versioned by the document it comes from', () => {
    // A changed notice needs a fresh consent, and `notice_version` is what makes
    // "which text did they agree to" answerable during an audit.
    const document = readFileSync(fileURLToPath(NOTICE_DOC), 'utf8')
    expect(document).toContain(`noticeVersion: ${CONSENT_NOTICE_VERSION}`)
  })
})
