import { describe, expect, it } from 'vitest'

import {
  ActorSchema,
  ChannelRefSchema,
  ConsentedActorSchema,
  DISPLAY_NAME_MAX_LENGTH,
  DisplayNameSchema,
  type ConsentedActor,
} from './identity.js'

/**
 * The consented identity of BOARD D-9. Every value here is an obviously
 * synthetic test value (spec §2.6): no captured name and no real channel id
 * appears in this package.
 */

const CONSENTED: ConsentedActor = {
  kind: 'consented',
  displayName: 'synthetic-viewer-1',
  channelRef: 'ref_0123456789abcdef0123456789abcdef',
}

describe('ChannelRef', () => {
  it('accepts the opaque reference the server issues', () => {
    expect(ChannelRefSchema.parse('ref_0123456789abcdef0123456789abcdef')).toBe(
      'ref_0123456789abcdef0123456789abcdef',
    )
  })

  it('refuses a YouTube channel id, in any spelling a derivation could produce', () => {
    // A channel id is `UC` + 22 base64url characters, so it has upper case, no
    // `ref_` prefix and the wrong length. Nothing derived from one — an
    // upper-case hash, a base64url digest — fits either (TASK_SPECS §T20a).
    expect(ChannelRefSchema.safeParse('UC_TEST_SYNTHETIC_0001').success).toBe(false)
    expect(ChannelRefSchema.safeParse('ref_0123456789ABCDEF0123456789ABCDEF').success).toBe(false)
    expect(ChannelRefSchema.safeParse('0123456789abcdef0123456789abcdef').success).toBe(false)
    expect(ChannelRefSchema.safeParse('ref_0123456789abcdef').success).toBe(false)
  })
})

describe('DisplayName', () => {
  it('accepts a Japanese name and a name with an emoji', () => {
    expect(DisplayNameSchema.safeParse('テスト視聴者1').success).toBe(true)
    // Emoji join with U+200D, a format character, so format characters must not
    // be excluded along with the control characters.
    expect(DisplayNameSchema.safeParse('synthetic-viewer-1 \u{1f469}\u200d\u{1f680}').success).toBe(
      true,
    )
  })

  it('refuses a control character or a second line', () => {
    expect(DisplayNameSchema.safeParse('synthetic\nviewer').success).toBe(false)
    expect(DisplayNameSchema.safeParse('synthetic\u0007viewer').success).toBe(false)
    expect(DisplayNameSchema.safeParse('synthetic\u2028viewer').success).toBe(false)
  })

  it('refuses an empty name and one past the documented ceiling', () => {
    expect(DisplayNameSchema.safeParse('').success).toBe(false)
    expect(DisplayNameSchema.safeParse('x'.repeat(DISPLAY_NAME_MAX_LENGTH)).success).toBe(true)
    expect(DisplayNameSchema.safeParse('x'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)).success).toBe(false)
  })
})

describe('Actor (spec §7.4, BOARD D-9)', () => {
  it('is null for everyone who has not consented', () => {
    expect(ActorSchema.parse(null)).toBeNull()
  })

  it('accepts the one consented shape', () => {
    expect(ActorSchema.parse(CONSENTED)).toEqual(CONSENTED)
  })

  it('refuses a second consent basis', () => {
    // D-9 approved exactly one: opt-in by command after the on-screen notice.
    expect(ConsentedActorSchema.safeParse({ ...CONSENTED, kind: 'inferred' }).success).toBe(false)
  })

  it('refuses a raw channel id beside the reference', () => {
    expect(
      ConsentedActorSchema.safeParse({ ...CONSENTED, channelId: 'UC_TEST_SYNTHETIC_0001' }).success,
    ).toBe(false)
    expect(
      ConsentedActorSchema.safeParse({ ...CONSENTED, channelRef: 'UC_TEST_SYNTHETIC_0001' })
        .success,
    ).toBe(false)
  })

  it('refuses a partly filled actor', () => {
    // Half an identity is still an identity: a name with no reference could not
    // be deleted on `LEAVE`, and a reference with no name has nothing to show.
    expect(ConsentedActorSchema.safeParse({ kind: 'consented' }).success).toBe(false)
    expect(
      ConsentedActorSchema.safeParse({ kind: 'consented', displayName: 'synthetic-viewer-1' })
        .success,
    ).toBe(false)
    expect(
      ConsentedActorSchema.safeParse({ kind: 'consented', channelRef: CONSENTED.channelRef })
        .success,
    ).toBe(false)
  })
})
