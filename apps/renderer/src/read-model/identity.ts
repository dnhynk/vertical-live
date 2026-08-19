import { DISPLAY_NAME_MAX_LENGTH, type Effect, type WorldSnapshot } from '@vl/contract'

/**
 * The one place in the renderer that reads `actor` (BOARD D-9, TASK_SPECS
 * §T20c).
 *
 * D-9 opened exactly one door: a viewer who sent the consent command may have
 * their display name shown next to *their own* action. Everything else on the
 * screen stays as anonymous as it was while the gate was closed (BOARD A-1) —
 * the paid acknowledgement above all (spec §8.4, §8.5), which is why no
 * component may reach `actor` itself. `identity-confinement.test.ts` keeps that
 * true over the sources; this module is what the slot is allowed to call.
 *
 * Two rules shape the code below.
 *
 * 1. **A name is attached to an action only when the action is provably that
 *    person's.** The snapshot carries no name at all (T20a: the read model
 *    recovers anonymously), so the name has to be joined from the
 *    `ACTION_REACTION` effect that caused the slot's action. A join that is not
 *    certain is not made — crediting the wrong viewer would be a participation
 *    claim that is not true (spec §2.6).
 * 2. **The renderer remembers nothing.** The name lives exactly as long as the
 *    effect that carried it, so `LEAVE`'s "delete immediately" (D-9) cannot be
 *    undone by an afterimage held here, and a reload recovers a screen with no
 *    name on it from the snapshot alone (spec §10.2).
 */

/**
 * How much of a display name the screen shows, in grapheme clusters.
 *
 * Provisional (BOARD A-15): neither the spec nor D-9 fixes a display width. The
 * contract's `DISPLAY_NAME_MAX_LENGTH` (100) is a *storage* bound and its own
 * comment says the screen decides its own. This value is that decision: the name
 * shares one line of the "just applied action" slot with the command, the
 * contribution count and the JST time on a 1080px-wide stage, so it is short
 * enough to leave the rest of the slot readable. It sits just below the only
 * documented channel-title maximum ([S3] `brandingSettings.channel.title`, 30
 * characters, checked 2026-08-19 in `packages/contract/src/identity.ts`), so most
 * names arrive whole and a long one is shortened rather than allowed to take the
 * line. `.slot-actor` in `index.css` clips as a second, purely visual backstop
 * for unusually wide glyphs.
 */
export const DISPLAY_NAME_SCREEN_MAX_GRAPHEMES = 20

/** Appended when a name was cut, so a shortened name never reads as the whole one. */
const ELLIPSIS = '…'

/**
 * Retention the on-screen notice states, in days.
 *
 * Not a renderer policy: the server deletes the record (T20b,
 * `config/retention.json`) and the number is fixed from outside by [S41]
 * Developer Policies III.E.4.c, which caps Authorized Data at 30 days
 * (https://developers.google.com/youtube/terms/developer-policies, checked
 * 2026-08-19 by T20b; BOARD D-9 was corrected from 90 to 30 the same day). It is
 * restated here only because the CTA has to say it out loud.
 */
export const CONSENT_RETENTION_DAYS = 30

/**
 * Characters removed before a name reaches the screen.
 *
 * `Cc` (C0/C1 controls) and `Zl`/`Zp` cannot appear in a value that passed
 * `DisplayNameSchema`, so removing them is a second lock rather than the first
 * one. `Cf` is the class the contract deliberately allows — an emoji sequence
 * joins with U+200D — and it is also where the bidirectional overrides live
 * (U+061C, U+200E/U+200F, U+202A–U+202E, U+2066–U+2069): those reorder the text
 * around them, so a name could visually swap places with the command or the
 * count beside it. Dropping all of `Cf` except the zero-width joiner keeps emoji
 * sequences whole and takes the reordering away.
 *
 * Emoji themselves are kept. They are part of the name the viewer asked to have
 * shown, and the bound below is measured in grapheme clusters, so a name made of
 * them is shortened rather than mangled.
 */
const ZERO_WIDTH_JOINER = '\u200d'
const REMOVED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** Runs of any whitespace collapse to one space: a name is one line, always. */
const WHITESPACE = /\s+/gu

/**
 * Grapheme clusters, so a cut never lands inside an emoji sequence or in front
 * of a combining mark. `Intl.Segmenter` is ECMA-402 and present in both runtimes
 * the renderer targets (Node 24 for the tests, Chromium for the OBS browser
 * source).
 */
const GRAPHEMES = new Intl.Segmenter('ja', { granularity: 'grapheme' })

function graphemesOf(value: string): string[] {
  return [...GRAPHEMES.segment(value)].map((segment) => segment.segment)
}

/**
 * A consented viewer's display name, made safe to put in a React text node, or
 * `null` when nothing printable is left.
 *
 * The output is text, never markup: React escapes it and the slot renders it as
 * a text node, so there is no HTML path here at all (spec §12.3 — the same
 * reason the renderer has no `innerHTML` anywhere).
 */
export function sanitizeDisplayName(raw: string): string | null {
  // A value longer than the contract allows never validated, so it did not come
  // in over the socket. Refusing it is cheaper than reasoning about where it did
  // come from — but only if "longer" is measured the way the contract measures
  // it. `DisplayNameSchema`'s quantifier runs under the `u` flag, so its 100 is
  // 100 *code points*; `String.length` is UTF-16 code units and counts every
  // astral character twice. Spreading the string iterates code points, so a name
  // of 60 emoji (120 code units, 60 code points) is now accepted here exactly as
  // the contract accepted it, and shortened below by grapheme cluster instead of
  // being refused outright. The character cleanup that follows stays a second
  // lock rather than becoming the first one: parsing with the schema instead
  // would turn a control character into a rejected name rather than a cleaned
  // one, which is the opposite of what this function is for.
  if ([...raw].length > DISPLAY_NAME_MAX_LENGTH) return null

  let cleaned = ''
  for (const character of raw.normalize('NFC')) {
    if (character !== ZERO_WIDTH_JOINER && REMOVED.test(character)) continue
    cleaned += character
  }

  const collapsed = cleaned.replace(WHITESPACE, ' ').trim()
  if (collapsed === '') return null

  const graphemes = graphemesOf(collapsed)
  if (graphemes.length <= DISPLAY_NAME_SCREEN_MAX_GRAPHEMES) return collapsed
  return graphemes.slice(0, DISPLAY_NAME_SCREEN_MAX_GRAPHEMES).join('') + ELLIPSIS
}

type ActionReactionEffect = Extract<Effect, { kind: 'ACTION_REACTION' }>

/**
 * The newest currently-playing reaction, or `null` when there is none, when two
 * are equally new, or when one of them carries a time that will not parse.
 *
 * A tie is refused rather than broken: two reactions staged in the same
 * millisecond are two different viewers' actions as far as this module can tell,
 * and picking either one would be a guess about whose name to print. Times are
 * compared as instants, not as strings — `IsoUtcInstantSchema` accepts both
 * `…:00Z` and `…:00.000Z`, which do not sort the way they read.
 */
function newestReaction(effects: readonly Effect[]): ActionReactionEffect | null {
  let newest: ActionReactionEffect | null = null
  let newestMs = Number.NEGATIVE_INFINITY
  let tied = false

  for (const effect of effects) {
    if (effect.kind !== 'ACTION_REACTION') continue
    const startsAtMs = Date.parse(effect.startsAt)
    if (Number.isNaN(startsAtMs)) return null
    if (newest === null || startsAtMs > newestMs) {
      newest = effect
      newestMs = startsAtMs
      tied = false
      continue
    }
    if (startsAtMs === newestMs) tied = true
  }

  return tied ? null : newest
}

/**
 * The display name to put in the "just applied action" slot (spec §5.2(2)), or
 * `null` for the anonymous slot the screen has drawn until now.
 *
 * The join, and why each condition is there:
 *
 * - the newest playing `ACTION_REACTION` is the candidate, because the server
 *   stages one for every applied command and the slot always shows the newest
 *   applied command. An older reaction that is still playing therefore belongs
 *   to an *older* action, and taking the newest is what stops viewer A's name
 *   from being printed over viewer B's action;
 * - its command and contribution count must equal the slot's. A reaction the
 *   slot is not describing cannot lend it a name;
 * - it must not have started after the slot's action was applied. A reaction
 *   newer than the snapshot means the two messages are out of step, and the name
 *   would be attached to the wrong one of them;
 * - an aggregated reaction never names anyone. The contract already refuses
 *   `actor` when `contributionCount > 1` (spec §6.4, §7.3); the equality above
 *   carries that through to the slot and the tests assert it.
 *
 * Anything short of all of that yields `null`. Anonymous is a state the screen is
 * already correct in; wrong about who acted is not one it can recover from.
 */
export function selectActionActorName(
  snapshot: WorldSnapshot | null,
  activeEffects: readonly Effect[],
): string | null {
  const action = snapshot?.display.lastAppliedAction ?? null
  if (action === null) return null

  const reaction = newestReaction(activeEffects)
  if (reaction === null) return null
  if (reaction.payload.commandName !== action.commandName) return null
  if (reaction.payload.contributionCount !== action.contributionCount) return null

  const appliedAtMs = Date.parse(action.appliedAt)
  if (Number.isNaN(appliedAtMs)) return null
  if (Date.parse(reaction.startsAt) > appliedAtMs) return null

  const actor = reaction.actor ?? null
  if (actor === null) return null
  return sanitizeDisplayName(actor.displayName)
}
