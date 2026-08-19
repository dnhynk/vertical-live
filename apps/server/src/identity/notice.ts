/**
 * Version of the consent notice a `JOIN` agrees to.
 *
 * Stored on every consent row so an API compliance audit can answer "which text
 * did this viewer agree to" (BOARD D-9; [S41] Developer Policies III.A.2 asks
 * the privacy policy to explain what is collected, and III.D.2.a asks for user
 * consent under applicable law).
 *
 * The full text lives in `docs/ops/identity-consent.md` and the version is the
 * date that text was last changed. Changing the notice means changing this
 * constant: existing rows then record the older version, which is what makes a
 * re-consent requirement visible instead of implied. `identity.test.ts` fails
 * when the document and this constant disagree.
 */
export const CONSENT_NOTICE_VERSION = '2026-08-20'
