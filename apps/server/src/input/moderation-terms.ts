/**
 * Banned-term seed list for the five categories spec §12.3 requires to be
 * discarded regardless of any command effect: hate, sexual, self-harm/violence
 * and advertising/scam patterns.
 *
 * Provenance and status
 * ---------------------
 * - **Operational system of record is YouTube Studio.** Spec §12.3 configures
 *   the channel's own blocked words and "Hold potentially inappropriate
 *   messages" (None/Basic/Strict) plus slow mode
 *   (https://support.google.com/youtube/answer/9826490?hl=en, [S16], read
 *   2026-08-17). This list is the second layer inside our own pipeline, not a
 *   replacement for it.
 * - **Authored here**, per category, for this repository. The widely used
 *   LDNOOBW corpus
 *   (https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words,
 *   CC BY 4.0, read 2026-08-17) has `en` and `ja` files but no category
 *   labels, so it is cited as a reference corpus and **not vendored**: §12.3
 *   needs the category to pick the rejection code.
 * - **Provisional** (BOARD A-15): the production list is expected to grow from
 *   operator review. Nothing in the pass criteria depends on its size.
 *
 * Matching form
 * -------------
 * Terms are written naturally here and are converted to the letter-only
 * skeleton at load time (`normalize.ts`), so an entry also catches its
 * full-width, katakana, spaced, punctuated and leetspeak spellings. Terms are
 * matched as substrings of the skeleton, which over-matches across word
 * boundaries; `moderation.ts` documents why that is the safe direction here.
 */

/** Categories of spec §12.3, each mapped to its own rejection code. */
export type ModerationCategory = 'hate' | 'sexual' | 'self_harm' | 'violence' | 'ads_scam'

export interface ModerationTermGroup {
  readonly category: ModerationCategory
  readonly language: 'ja' | 'en'
  readonly terms: readonly string[]
}

export const MODERATION_TERMS: readonly ModerationTermGroup[] = [
  {
    category: 'hate',
    language: 'en',
    terms: ['nigger', 'nigga', 'faggot', 'kike', 'chink', 'gook', 'spic', 'wetback', 'tranny'],
  },
  {
    category: 'hate',
    language: 'ja',
    terms: ['キチガイ', '気違い', '土人', 'チョン', 'シナ人', '部落民', 'ガイジ', '池沼'],
  },
  {
    category: 'sexual',
    language: 'en',
    terms: [
      'porn',
      'nsfw',
      'anal',
      'blowjob',
      'dildo',
      'cumshot',
      'hentai',
      'boobs',
      'nudes',
      'onlyfans',
      'xvideos',
      'masturbat',
    ],
  },
  {
    category: 'sexual',
    language: 'ja',
    terms: [
      'エロ',
      'セックス',
      'おっぱい',
      'ちんこ',
      'まんこ',
      'アダルト',
      'ヌード',
      '風俗',
      '援交',
    ],
  },
  {
    category: 'self_harm',
    language: 'en',
    terms: ['killyourself', 'kys', 'suicide', 'selfharm', 'cutmyself', 'hangmyself'],
  },
  {
    category: 'self_harm',
    language: 'ja',
    terms: ['自殺', '死ね', '首吊り', 'リストカット', 'リスカ', '死にたい'],
  },
  {
    category: 'violence',
    language: 'en',
    terms: ['killyou', 'iwillkill', 'murderyou', 'rape', 'shootyou', 'stabyou', 'bombthreat'],
  },
  {
    category: 'violence',
    language: 'ja',
    terms: ['殺す', 'ぶっ殺', '爆破予告', 'テロ予告', '殴り殺'],
  },
  {
    category: 'ads_scam',
    language: 'en',
    terms: [
      'freerobux',
      'freevbucks',
      'giveaway',
      'sub4sub',
      'subscribetomy',
      'followmeon',
      'checkmychannel',
      'bitcoin',
      'crypto',
      'clickhere',
      'promocode',
      'makemoneyfast',
      'telegram',
      'whatsapp',
    ],
  },
  {
    category: 'ads_scam',
    language: 'ja',
    terms: [
      '無料配布',
      'プレゼント企画',
      '稼げる',
      '副業',
      '儲かる',
      'チャンネル登録して',
      '相互登録',
      'ライン交換',
      '高額報酬',
      '当選しました',
    ],
  },
]
