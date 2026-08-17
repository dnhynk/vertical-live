/**
 * Confusable (homoglyph) folding data, used **only** by the rejection checks.
 *
 * Unicode UTS #39 defines a full `skeleton()` over `confusables.txt`
 * (https://www.unicode.org/reports/tr39/, data file
 * https://www.unicode.org/Public/security/latest/confusables.txt, both read
 * 2026-08-17). That table is ~6,000 entries and is explicitly documented as
 * unstable across Unicode versions, so it is not vendored here. This module
 * carries the subset that matters for a Latin/Japanese command allowlist: the
 * Cyrillic, Greek, small-capital and letterlike characters that render as ASCII
 * letters, plus kana width/voicing folding that NFKC does not cover.
 *
 * Direction matters. Folding is a *permissive* transform: it makes more inputs
 * look alike. Applying it to command matching would widen what counts as a
 * command, so `normalize.ts` applies it only when building the strings that the
 * URL / personal-data / banned-term checks read. Every fold can therefore only
 * ever add a rejection, never remove one.
 */

/**
 * Confusable → ASCII. Keys are lower-case: the caller folds case first.
 * NFKC already handles full-width forms, mathematical alphanumerics, circled
 * letters and Roman numerals, so none of those appear here.
 */
export const HOMOGLYPH_FOLD: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a',
  б: 'b',
  в: 'b',
  г: 'r',
  ԁ: 'd',
  е: 'e',
  ѐ: 'e',
  ё: 'e',
  з: '3',
  и: 'u',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  ө: 'o',
  п: 'n',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  ү: 'y',
  ф: 'o',
  х: 'x',
  ѕ: 's',
  ԛ: 'q',
  ԝ: 'w',
  ѵ: 'v',
  // Greek
  α: 'a',
  β: 'b',
  γ: 'y',
  ε: 'e',
  ζ: 'z',
  η: 'n',
  ι: 'i',
  κ: 'k',
  μ: 'm',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  σ: 'o',
  τ: 't',
  υ: 'u',
  φ: 'o',
  χ: 'x',
  ω: 'w',
  // Latin letters outside ASCII that NFKC keeps distinct
  ı: 'i',
  ȷ: 'j',
  ſ: 's',
  ʟ: 'l',
  ɡ: 'g',
  ɢ: 'g',
  ʀ: 'r',
  ʙ: 'b',
  ᴀ: 'a',
  ᴄ: 'c',
  ᴅ: 'd',
  ᴇ: 'e',
  ғ: 'f',
  ʜ: 'h',
  ɪ: 'i',
  ᴊ: 'j',
  ᴋ: 'k',
  ᴍ: 'm',
  ɴ: 'n',
  ᴏ: 'o',
  ᴘ: 'p',
  ꜱ: 's',
  ᴛ: 't',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  ʏ: 'y',
  ᴢ: 'z',
  // Letterlike symbols NFKC leaves alone
  ℓ: 'l',
  '℮': 'e',
  '∅': 'o',
  '∆': 'a',
  '∏': 'n',
  '∑': 'e',
  '√': 'v',
  '∞': 'oo',
}

/**
 * Digit / punctuation substitutions ("leetspeak"). Applied **only** to the
 * banned-term skeleton, never to URL or personal-data checks, because those two
 * need real digits and real punctuation to work.
 */
export const LEET_FOLD: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '¡': 'i',
  '+': 't',
  '&': 'a',
  '€': 'e',
  '£': 'l',
}

/** First and last code points of the katakana block folded to hiragana. */
export const KATAKANA_START = 0x30a1
export const KATAKANA_END = 0x30f6
/** Katakana → hiragana distance in the Unicode kana blocks. */
export const KANA_FOLD_OFFSET = 0x60
