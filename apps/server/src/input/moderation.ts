import { MODERATION_TERMS, type ModerationCategory } from './moderation-terms.js'
import { normalizeText, type NormalizedText } from './normalize.js'
import type { RejectionReason } from './types.js'

/**
 * Rejection rules of spec §12.3: personal data, hate, sexual content,
 * self-harm/violence and advertising/scam patterns are discarded regardless of
 * any command effect, and links are held.
 *
 * Every function here takes the normalized forms and returns a reason code.
 * The message is never returned, logged or stored — including which term
 * matched, which would leak a fragment of it.
 *
 * The rules are defence in depth, not the primary barrier. `parse.ts` accepts
 * exactly `command [short token]` and rejects everything else, so text that
 * carries a link or a slur is already unacceptable on shape alone; these rules
 * decide the *code* such a message is rejected with, and catch the cases the
 * shape rule cannot see (a banned word that is short enough to be an argument,
 * or a lone banned word that a laxer allowlist would let through).
 */

const CATEGORY_REASON: Readonly<Record<ModerationCategory, RejectionReason>> = {
  hate: 'banned_hate',
  sexual: 'banned_sexual',
  self_harm: 'banned_self_harm',
  violence: 'banned_violence',
  ads_scam: 'banned_ads_scam',
}

/** Deterministic evaluation order, so one message always yields one code. */
const CATEGORY_ORDER: readonly ModerationCategory[] = [
  'hate',
  'sexual',
  'self_harm',
  'violence',
  'ads_scam',
]

interface CompiledTerms {
  readonly category: ModerationCategory
  readonly skeletons: readonly string[]
}

/**
 * Terms are compiled through the same pipeline as the message, so an entry
 * written as `セックス` also matches `ｾｯｸｽ`, `せ っ く す` and `せくす`-style
 * spellings without the data file having to spell them out.
 */
const COMPILED_TERMS: readonly CompiledTerms[] = CATEGORY_ORDER.map((category) => ({
  category,
  skeletons: MODERATION_TERMS.filter((group) => group.category === category)
    .flatMap((group) => group.terms)
    .map((term) => normalizeText(term).skeleton)
    .filter((skeleton) => skeleton.length > 0),
}))

/**
 * `example(dot)com` and `example dot com` → `example.com`, and the same for
 * `(at)` → `@`. A delimiter is required on at least one side so that ordinary
 * words containing `dot` or `at` (`anecdote`, `water`) are left alone.
 */
const BRACKETED_DOT = /\s*[([{<]\s*(?:dot|どっと)\s*[)\]}>]\s*/g
const SPACED_WORD_DOT = /(?<=[a-z0-9])\s+(?:dot|どっと)\s+(?=[a-z0-9])/g
const BRACKETED_AT = /\s*[([{<]\s*(?:at|あっと)\s*[)\]}>]\s*/g
const SPACED_WORD_AT = /(?<=[a-z0-9])\s+(?:at|あっと)\s+(?=[a-z0-9])/g
const SPACED_DOT = /\s*\.\s*/g
const SCHEME_TYPO = /h[x*]{2}p/g

/**
 * A link is a scheme, a `www.` host, or any two labels joined by a dot. The
 * last rule takes no TLD list: a list is a moving target and missing an entry
 * is the failure that matters, while matching a dotted word that was not a host
 * only changes which rejection code an already-unacceptable message gets.
 */
const URL_PATTERNS: readonly RegExp[] = [
  /:\/\//,
  /(?:^|[^a-z0-9])www\.[a-z0-9-]/,
  /(?:^|[^a-z0-9.-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z]{2,24}(?![a-z0-9-])/,
]

const IP_PATTERN = /(?:^|[^0-9])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:[^0-9]|$)/
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/
const HANDLE_PATTERN = /(?:^|[^a-z0-9_])@[a-z0-9_.]{3,}/
const JP_POSTAL_PATTERN = /〒\s*\d{3}-?\d{4}/
/** Separators stripped before counting digits, so `090-1234-5678` is one run. */
const NUMBER_SEPARATORS = /[\s\-().+_]/g
/**
 * Nine digits is the shortest run that reaches a real contact number: Japanese
 * mobile numbers are 11 digits, land lines 10, international forms longer, and
 * card numbers 13–19. Shorter runs (dates, scores, `〒` alone) stay legal.
 */
const LONG_DIGIT_RUN = /\d{9,}/

/**
 * `folded` with link obfuscation undone. Built once per message and shared by
 * the link and personal-data rules, which both need punctuation intact — so
 * this is *not* the banned-term skeleton.
 */
export function buildLinkProbe(folded: string): string {
  return folded
    .replace(SCHEME_TYPO, 'http')
    .replace(BRACKETED_DOT, '.')
    .replace(SPACED_WORD_DOT, '.')
    .replace(BRACKETED_AT, '@')
    .replace(SPACED_WORD_AT, '@')
    .replace(SPACED_DOT, '.')
}

function containsLink(probe: string): boolean {
  return URL_PATTERNS.some((pattern) => pattern.test(probe))
}

/** Personal data other than an address, which `moderate` checks first. */
function containsContactData(probe: string): boolean {
  if (HANDLE_PATTERN.test(probe)) return true
  if (JP_POSTAL_PATTERN.test(probe)) return true
  return LONG_DIGIT_RUN.test(probe.replace(NUMBER_SEPARATORS, ''))
}

function bannedCategory(skeleton: string): ModerationCategory | null {
  if (skeleton.length === 0) return null
  for (const { category, skeletons } of COMPILED_TERMS) {
    if (skeletons.some((term) => skeleton.includes(term))) {
      return category
    }
  }
  return null
}

/**
 * Returns the rejection code for a message, or `null` when nothing matched.
 *
 * Order is fixed so the same message always produces the same code: an address
 * is personal data before it is a link, a bare IP or host is a link, and the
 * banned-term categories follow §12.3's own order.
 */
export function moderate(text: NormalizedText): RejectionReason | null {
  const probe = buildLinkProbe(text.folded)
  if (EMAIL_PATTERN.test(probe)) return 'personal_data'
  if (containsLink(probe) || IP_PATTERN.test(probe)) return 'url'
  if (containsContactData(probe)) return 'personal_data'
  const category = bannedCategory(text.skeleton)
  return category === null ? null : CATEGORY_REASON[category]
}

/** Compiled term skeletons, exposed so tests can assert alias/term disjointness. */
export function compiledTermSkeletons(): readonly string[] {
  return COMPILED_TERMS.flatMap((group) => group.skeletons)
}
