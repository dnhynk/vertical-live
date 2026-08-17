import { describe, expect, it } from 'vitest'

import { aliasKeys } from './aliases.js'
import { buildLinkProbe, compiledTermSkeletons, moderate } from './moderation.js'
import { normalizeText } from './normalize.js'

const check = (text: string) => moderate(normalizeText(text))

describe('link rules', () => {
  it.each([
    ['scheme', 'https://example.invalid/spam'],
    ['scheme typo', 'hxxps://example.invalid'],
    ['www host', 'www.example.invalid'],
    ['bare host', 'example.invalid'],
    ['bracketed dot', 'example(dot)invalid'],
    ['spaced dot word', 'example dot com'],
    ['spaced punctuation', 'example . com'],
    ['confusable host', 'ехample.com'],
    ['zero width inside host', 'exam​ple.com'],
    ['ip address', '192.0.2.10'],
    // R-T6-1 blocker 1: separators that are legal argument characters.
    ['hyphen separated host', 'www-example-com'],
    ['underscore separated host', 'www_example_com'],
    ['hyphen dot word', 'example-dot-com'],
    ['underscore dot word', 'example_dot_com'],
    ['pipe separated host', 'www|example|com'],
    ['ideographic full stop', 'example。com'],
    ['halfwidth ideographic stop', 'example｡com'],
  ])('rejects a %s as url', (_name, text) => {
    expect(check(text)).toBe('url')
  })

  it('leaves an ordinary hyphenated word alone', () => {
    // Two segments are wording, not a host; three or a leading `www` are not.
    expect(check('tag-game')).toBeNull()
    expect(check('snack_time')).toBeNull()
  })

  it('leaves ordinary text alone', () => {
    expect(check('feed')).toBeNull()
    expect(check('ごはん')).toBeNull()
    expect(check('play tag-game')).toBeNull()
  })

  it('does not turn ordinary words containing "dot" or "at" into links', () => {
    expect(buildLinkProbe('anecdote water')).toBe('anecdote water')
  })
})

describe('personal data rules', () => {
  it.each([
    ['email', 'someone@example.invalid'],
    ['obfuscated email', 'someone (at) example.invalid'],
    ['phone number', '090-1234-5678'],
    ['card-length digits', '4111 1111 1111 1111'],
    ['social handle', '@synthetic_handle'],
    ['japanese postal code', '〒123-4567'],
    // R-T6-1 blocker 1: the form that survived as one accepted argument token.
    ['hyphen separated address', 'someone-at-example-dot-com'],
    ['underscore separated address', 'someone_at_example_dot_com'],
  ])('rejects %s as personal data', (_name, text) => {
    expect(check(text)).toBe('personal_data')
  })

  it('allows short numbers that are not contact details', () => {
    expect(check('feed 12345678')).toBeNull()
  })
})

describe('banned term rules', () => {
  it.each([
    ['hate', 'ｷﾁｶﾞｲ', 'banned_hate'],
    ['sexual leetspeak', 'p0rn', 'banned_sexual'],
    ['sexual confusable', 'ро rn', 'banned_sexual'],
    ['self harm japanese', '死ね', 'banned_self_harm'],
    ['self harm spaced', 'k y s', 'banned_self_harm'],
    ['violence japanese', '殺す', 'banned_violence'],
    ['ads japanese', '無料配布', 'banned_ads_scam'],
    ['ads separated', 's-u-b-4-s-u-b', 'banned_ads_scam'],
  ])('rejects %s', (_name, text, reason) => {
    expect(check(text)).toBe(reason)
  })
})

describe('allowlist and banned terms are disjoint', () => {
  it('never lets a banned term match a legitimate command spelling', () => {
    const terms = compiledTermSkeletons()
    expect(terms.length).toBeGreaterThan(0)
    for (const key of aliasKeys()) {
      const skeleton = normalizeText(key).skeleton
      for (const term of terms) {
        expect(skeleton.includes(term), `${key} matched ${term}`).toBe(false)
      }
    }
  })

  it('accepts every alias through the moderation gate unchanged', () => {
    for (const key of aliasKeys()) {
      expect(moderate(normalizeText(key)), key).toBeNull()
    }
  })
})
