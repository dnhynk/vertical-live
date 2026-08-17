import type { CommandName } from '@vl/contract'

import type { RejectionReason } from '../types.js'

/**
 * Adversarial and benign-obfuscation vectors for the command parser
 * (`docs/tasks/TASK_SPECS.md` §T6 acceptance 1). They extend the T1 source
 * fixtures, which carry whole API items; these are message strings, which is
 * the unit the parser works on.
 *
 * Two halves, and both matter:
 *
 * - `expectRejected` — a crafted message must not reach the world. A bypass is
 *   any vector here that comes back accepted.
 * - `expectAccepted` — an ordinary message dressed up by the platform (full
 *   width from a Japanese IME, a stray zero-width joiner, a trailing `！`) must
 *   still work. Over-blocking these would quietly kill the "명령 성공" metric
 *   of spec §14.1, so they are pass criteria too.
 *
 * Every string is synthetic. There are no captured chat messages, no real user
 * names and no real contact details: `example.invalid` is the reserved test
 * domain (RFC 2606) and the numbers are obviously fabricated (spec §2.6).
 */

export interface RejectedVector {
  readonly name: string
  readonly text: string
  readonly reason: RejectionReason
}

export interface AcceptedVector {
  readonly name: string
  readonly text: string
  readonly command: CommandName
  readonly argument?: string
}

const ZWSP = '​'
const ZWJ = '‍'
const RLO = '‮'
const LRI = '⁦'
const SOFT_HYPHEN = '­'
const TAG_LETTER_A = '\u{E0041}'
const HANGUL_FILLER = 'ㅤ'
const BRAILLE_BLANK = '⠀'
const VARIATION_SELECTOR_16 = '️'

export const REJECTED_VECTORS: readonly RejectedVector[] = [
  // Links, in the spellings that get used to slip past a naive filter.
  { name: 'plain link', text: 'feed https://example.invalid/spam', reason: 'url' },
  { name: 'scheme typo', text: 'feed hxxps://example.invalid', reason: 'url' },
  { name: 'bracketed dot', text: 'feed example(dot)invalid', reason: 'url' },
  { name: 'spaced dot word', text: 'feed example dot com', reason: 'url' },
  { name: 'spaced punctuation dot', text: 'feed example . com', reason: 'url' },
  { name: 'www host', text: 'feed www.example.invalid', reason: 'url' },
  { name: 'confusable host', text: 'feed ехample.com', reason: 'url' },
  { name: 'full width host', text: 'ｆｅｅｄ　ｅｘａｍｐｌｅ．ｃｏｍ', reason: 'url' },
  { name: 'bare ip', text: 'feed 192.0.2.10', reason: 'url' },
  { name: 'zero width inside host', text: `feed exam${ZWSP}ple.com`, reason: 'url' },
  // R-T6-1 blocker 1: separators that are legal argument characters were not
  // treated as dots, so a host or address survived as a single valid token.
  { name: 'hyphen separated host', text: 'feed www-example-com', reason: 'url' },
  { name: 'underscore separated host', text: 'feed www_example_com', reason: 'url' },
  { name: 'hyphen dot word host', text: 'feed example-dot-com', reason: 'url' },
  { name: 'ideographic full stop host', text: 'feed example。com', reason: 'url' },
  { name: 'halfwidth ideographic stop host', text: 'feed example｡com', reason: 'url' },
  // Personal data.
  { name: 'email', text: 'feed someone@example.invalid', reason: 'personal_data' },
  { name: 'obfuscated email', text: 'feed someone (at) example.invalid', reason: 'personal_data' },
  {
    name: 'hyphen separated address',
    text: 'feed someone-at-example-dot-com',
    reason: 'personal_data',
  },
  {
    name: 'underscore separated address',
    text: 'feed someone_at_example_dot_com',
    reason: 'personal_data',
  },
  { name: 'phone number', text: 'feed 090-1234-5678', reason: 'personal_data' },
  { name: 'card-length digits', text: 'feed 4111111111111111', reason: 'personal_data' },
  { name: 'social handle', text: 'feed @synthetic_handle', reason: 'personal_data' },
  { name: 'japanese postal code', text: 'feed 〒123-4567', reason: 'personal_data' },
  // Banned terms, one per category, each obfuscated a different way.
  { name: 'hate half width katakana', text: 'ｷﾁｶﾞｲ', reason: 'banned_hate' },
  { name: 'sexual leetspeak', text: 'feed p0rn', reason: 'banned_sexual' },
  { name: 'sexual confusable', text: 'feed ро rn', reason: 'banned_sexual' },
  // R-T6-1 reviewer probe: a combining mark on every letter.
  { name: 'sexual struck through', text: 'feed p̸o̸r̸n̸', reason: 'banned_sexual' },
  { name: 'self harm japanese', text: 'feed 死ね', reason: 'banned_self_harm' },
  { name: 'self harm spaced', text: 'k y s', reason: 'banned_self_harm' },
  { name: 'violence japanese', text: '殺す', reason: 'banned_violence' },
  { name: 'ads japanese', text: '無料配布 feed', reason: 'banned_ads_scam' },
  { name: 'ads separated', text: 'feed s-u-b-4-s-u-b', reason: 'banned_ads_scam' },
  // Shape: the allowlist is a command and at most one short token.
  {
    name: 'command plus sentence',
    text: 'feed the creature now please',
    reason: 'extraneous_text',
  },
  { name: 'two commands', text: 'feed play', reason: 'extraneous_text' },
  {
    name: 'forty word tokens',
    text: `feed ${Array.from({ length: 40 }, (_, index) => `w${index}`).join(' ')}`,
    reason: 'extraneous_text',
  },
  { name: 'argument too long', text: `feed ${'a'.repeat(33)}`, reason: 'invalid_argument' },
  { name: 'argument with japanese', text: 'ごはん りんご', reason: 'invalid_argument' },
  // R-T6-1 blocker 1: an argument is a plain word, so no separator can be used
  // to spell something else inside one (`moderation.ts` catches the ones that
  // still read as a host or address first).
  { name: 'argument with hyphen', text: 'play tag-game', reason: 'invalid_argument' },
  { name: 'argument with underscore', text: 'play snack_time', reason: 'invalid_argument' },
  { name: 'near miss alias', text: 'feeeed', reason: 'no_command' },
  { name: 'alias substring', text: 'feeder', reason: 'no_command' },
  { name: 'unrelated japanese', text: 'こんばんは', reason: 'no_command' },
  // R-T6-1 reviewer probe: confusable folding must not widen the allowlist.
  { name: 'confusable alias', text: 'fеed', reason: 'no_command' },
  { name: 'invisible only', text: `${ZWSP}${ZWJ}${SOFT_HYPHEN}${BRAILLE_BLANK}`, reason: 'empty' },
  { name: 'over length', text: 'a'.repeat(501), reason: 'too_long' },
]

/**
 * Vectors that must still be accepted. The `vote_disabled` gate is deliberately
 * absent here: `VOTE_A/B/C` depend on the parse context, so `parse.test.ts`
 * drives them with both gate states instead.
 */
export const ACCEPTED_VECTORS: readonly AcceptedVector[] = [
  { name: 'canonical name', text: 'FEED', command: 'FEED' },
  { name: 'lower case alias', text: 'feed', command: 'FEED' },
  { name: 'japanese alias', text: 'ごはん', command: 'FEED' },
  { name: 'icon alias', text: '🍙', command: 'FEED' },
  { name: 'full width alias', text: 'ＦＥＥＤ', command: 'FEED' },
  { name: 'mathematical alphanumerics', text: '𝐅𝐄𝐄𝐃', command: 'FEED' },
  { name: 'zero width joiner inside', text: `FE${ZWJ}ED`, command: 'FEED' },
  { name: 'zero width space inside', text: `FE${ZWSP}ED`, command: 'FEED' },
  { name: 'hangul filler inside', text: `FE${HANGUL_FILLER}ED`, command: 'FEED' },
  { name: 'tag character appended', text: `FEED${TAG_LETTER_A}`, command: 'FEED' },
  { name: 'rtl override prefix', text: `${RLO}FEED`, command: 'FEED' },
  { name: 'bidi isolate prefix', text: `${LRI}feed`, command: 'FEED' },
  { name: 'combining marks stacked', text: 'F̈E̋E̊D̃', command: 'FEED' },
  { name: 'surrounding whitespace', text: '\t feed \n', command: 'FEED' },
  { name: 'ideographic space', text: '　ごはん　', command: 'FEED' },
  { name: 'japanese exclamation', text: 'ごはん！', command: 'FEED' },
  { name: 'ascii punctuation', text: 'feed!!!', command: 'FEED' },
  { name: 'quoted alias', text: '「あそぶ」', command: 'PLAY' },
  { name: 'heart with variation selector', text: `❤${VARIATION_SELECTOR_16}`, command: 'PET' },
  { name: 'heart without variation selector', text: '❤', command: 'PET' },
  { name: 'play alias', text: 'あそぶ', command: 'PLAY' },
  { name: 'play icon', text: '🎾', command: 'PLAY' },
  { name: 'pet alias', text: 'なでる', command: 'PET' },
  { name: 'short argument', text: 'feed apple', command: 'FEED', argument: 'apple' },
  { name: 'alphanumeric argument', text: 'play round2', command: 'PLAY', argument: 'round2' },
  // R-T6-1 reviewer probe, retained as an intentional policy decision: tokens
  // that are punctuation only are trimmed away, so a wall of them is still just
  // the command. Nothing of the message survives — the argument stays `null`.
  {
    name: 'forty punctuation tokens',
    text: `feed ${Array.from({ length: 40 }, () => '!?.').join(' ')}`,
    command: 'FEED',
  },
]

/**
 * Marker substrings that must never appear in a parser return value, in the
 * metrics snapshot or on any stream, for the rejected vectors that carry them
 * (spec §12.3, §7.3(1)).
 */
export const LEAK_MARKERS: readonly string[] = [
  'example.invalid',
  'www-example-com',
  'someone-at-example',
  'someone',
  'synthetic_handle',
  '4111111111111111',
  '090-1234-5678',
  'p0rn',
  '無料配布',
]
