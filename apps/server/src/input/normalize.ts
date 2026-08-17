import {
  HOMOGLYPH_FOLD,
  KANA_FOLD_OFFSET,
  KATAKANA_END,
  KATAKANA_START,
  LEET_FOLD,
} from './homoglyphs.js'

/**
 * Text normalization for the command parser (spec §7.1: "Unicode 정규화 후
 * allowlist와 명시적 별칭만 받는다", §7.3(1)).
 *
 * Three forms are derived, and which check reads which form is a safety
 * decision, not a convenience one:
 *
 * | form        | built from            | read by                          |
 * |-------------|-----------------------|----------------------------------|
 * | `normalized`| NFKC + invisible/mark removal + case + spaces | alias matching, URL, personal data |
 * | `folded`    | `normalized` + confusable + kana folding      | URL, personal data                 |
 * | `skeleton`  | `folded` + leet folding + non-letter removal  | banned terms                       |
 *
 * Folding is permissive: it makes more strings equal. It is therefore kept out
 * of alias matching (where it would widen what counts as a command) and used
 * only by the rejection checks (where it can only add rejections). A confusable
 * `FEED` is not a command; a confusable slur is still a slur.
 *
 * Everything here is a pure function of its input. No raw text is retained.
 */

/** Result of normalizing one message. Never carries the original string. */
export interface NormalizedText {
  /** Alias-matching form: NFKC, invisibles gone, lower case, single spaces. */
  readonly normalized: string
  /** `normalized` with confusables folded to ASCII and katakana to hiragana. */
  readonly folded: string
  /** Letter-only skeleton of `folded` with leet substitutions applied. */
  readonly skeleton: string
}

/**
 * Characters that carry no glyph and exist only to break up text: format
 * controls (`Cf` — includes ZWSP/ZWJ/ZWNJ, LRM/RLM, the bidi embedding,
 * override and isolate controls, and the Unicode tag block), C0/C1 controls,
 * private-use and lone surrogates, variation selectors, the Hangul fillers and
 * the blank Braille pattern. Whitespace is converted before this runs, so no
 * legitimate separator reaches it.
 */
const INVISIBLE_PATTERN = new RegExp(
  '[' +
    '\\p{Cf}\\p{Cc}\\p{Co}\\p{Cs}' + // format, control, private use, lone surrogate
    '\\u180B-\\u180D\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}' + // variation selectors
    '\\u115F\\u1160\\u3164\\uFFA0' + // Hangul fillers (render as nothing)
    '\\u2800' + // blank Braille pattern
    ']',
  'gu',
)

/**
 * Combining marks that survived NFKC composition. A precomposed character
 * (`が`, `é`) has no leftover mark, so this only strips diacritics that were
 * stacked onto a base character to disguise it (`F̈E̋E̊D̃`). Scripts written with
 * standalone combining marks (Devanagari, Thai, Arabic) lose them here; the
 * allowlist is Japanese and ASCII, and a message in those scripts is rejected
 * as `no_command` either way.
 */
const LEFTOVER_MARK_PATTERN = /[\p{Mn}\p{Me}]/gu

const WHITESPACE_PATTERN = /\p{White_Space}+/gu

/** Everything that is not a letter is dropped from the banned-term skeleton. */
const NON_LETTER_PATTERN = /[^\p{L}]/gu

/**
 * Punctuation trimmed from the ends of the message and of each token before
 * alias matching, so that `ごはん！` and `FEED.` still reach `FEED`. It is a
 * fixed list rather than `\p{P}`: `-` and `_` are legal argument characters
 * (`CommandRefSchema`) and `ー` is a Japanese long vowel, so none of them may be
 * trimmed.
 */
const TRIMMED_PUNCTUATION = new Set([
  '!',
  '?',
  '.',
  ',',
  ';',
  ':',
  "'",
  '"',
  '`',
  '~',
  '^',
  '*',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  '、',
  '。',
  '，',
  '．',
  '・',
  '「',
  '」',
  '『',
  '』',
  '…',
  '〜',
])

/**
 * NFKC → whitespace → invisibles → NFKC again → leftover marks → case → spaces.
 *
 * The second NFKC matters: removing an invisible character can leave a base
 * character next to a combining mark that now composes (`e` ZWSP `◌́` → `é`),
 * and composing it before the mark sweep keeps the letter instead of dropping
 * the accent onto nothing.
 */
export function normalizeText(raw: string): NormalizedText {
  const normalized = raw
    .normalize('NFKC')
    .replace(WHITESPACE_PATTERN, ' ')
    .replace(INVISIBLE_PATTERN, '')
    .normalize('NFKC')
    .replace(LEFTOVER_MARK_PATTERN, '')
    .toLowerCase()
    .replace(WHITESPACE_PATTERN, ' ')
    .trim()

  const folded = foldConfusables(normalized)
  return { normalized, folded, skeleton: buildSkeleton(folded) }
}

/** Confusable letters → ASCII, katakana → hiragana. Case is already folded. */
export function foldConfusables(text: string): string {
  let out = ''
  for (const char of text) {
    const mapped = HOMOGLYPH_FOLD[char]
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    const code = char.codePointAt(0)
    if (code !== undefined && code >= KATAKANA_START && code <= KATAKANA_END) {
      out += String.fromCodePoint(code - KANA_FOLD_OFFSET)
      continue
    }
    out += char
  }
  return out
}

/**
 * Letter-only form used for banned-term substring matching: digits and symbols
 * become the letters they imitate, then every separator is removed so that
 * `s.e-x`, `s e x` and `53x` collapse to the same string.
 *
 * Removing separators over-matches (a banned term can appear across a word
 * boundary). That is deliberate: the accepted shape is `command [short token]`
 * and nothing else, so an over-match can only change *which* rejection code a
 * message that was already going to be rejected gets — and an alias can never
 * collide with a term (`moderation.test.ts` asserts it).
 */
export function buildSkeleton(folded: string): string {
  let out = ''
  for (const char of folded) {
    out += LEET_FOLD[char] ?? char
  }
  return out.replace(NON_LETTER_PATTERN, '')
}

/** Strips the trimmable punctuation from both ends of a token. */
export function trimPunctuation(token: string): string {
  const chars = [...token]
  let start = 0
  let end = chars.length
  while (start < end && TRIMMED_PUNCTUATION.has(chars[start] as string)) {
    start += 1
  }
  while (end > start && TRIMMED_PUNCTUATION.has(chars[end - 1] as string)) {
    end -= 1
  }
  return chars.slice(start, end).join('')
}

/** Space-separated tokens of the normalized form, each punctuation-trimmed. */
export function tokenize(normalized: string): string[] {
  return normalized
    .split(' ')
    .map(trimPunctuation)
    .filter((token) => token.length > 0)
}
