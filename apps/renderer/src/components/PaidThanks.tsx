import type { PaidEventKind } from '@vl/contract'

import type { Alias, Translate } from '../i18n/index'
import Icon from '../visual/icons'

/**
 * The paid acknowledgement (spec §8.4, §8.5, §9.2).
 *
 * This component is deliberately unable to touch the world. Its props are the
 * four presentation fields of the `PAID_THANKS` payload and the two text
 * functions — there is no snapshot here, no read model, no import from
 * `read-model/`, so a payment cannot move a need, a mission, a growth step or a
 * tally through the screen either. `paid-staging.test.ts` checks that statically,
 * which is TASK_SPECS §T14 acceptance 3.
 *
 * What it shows: a fixed animation chosen by the paid kind, an anonymous icon
 * the server picked, and the note that everything is reachable for free. What it
 * never shows: a supporter name (spec §12.3), an amount, a tier ranking or any
 * kind of spending leaderboard (spec §8.5) — the amount is not even in the
 * payload, and `tier` is not passed here, because nothing on screen may scale
 * with what someone paid.
 *
 * `fallback` marks the substitute acknowledgement that runs once when the
 * original staging window was lost to a degraded period (spec §9.2). It is the
 * same staging with a different caption, not a smaller one.
 */
export interface PaidThanksProps {
  readonly paidEventKind: PaidEventKind
  /** Anonymous icon id chosen by the server (spec §8.4 "안전한 아이콘"). */
  readonly iconId: string
  readonly fallback: boolean
  readonly translate: Translate
  readonly alias: Alias
}

/** Fixed, pre-described staging: same kind, same motion, every time (spec §8.4). */
const SPARK_COUNT = 6

export default function PaidThanks({
  paidEventKind,
  iconId,
  fallback,
  translate,
  alias,
}: PaidThanksProps) {
  const kindKey = `ui.thanks.${paidEventKind}`
  const kindAlias = alias(kindKey)

  return (
    <div
      className="paid-thanks"
      data-testid="paid-thanks"
      data-paid-kind={paidEventKind}
      data-fallback={fallback ? 'true' : 'false'}
    >
      <div className="paid-sparks" aria-hidden="true">
        {Array.from({ length: SPARK_COUNT }, (_unused, index) => (
          <span className={`paid-spark paid-spark-${index}`} key={index} />
        ))}
      </div>

      <Icon iconId={iconId} className="icon-thanks" />

      <p className="paid-thanks-title">{translate('ui.thanks.title')}</p>
      <p className="paid-thanks-kind">
        <span className="paid-thanks-kind-ja">{translate(kindKey)}</span>
        {kindAlias === null ? null : <span className="paid-thanks-kind-en">{kindAlias}</span>}
      </p>
      {fallback ? (
        <p className="paid-thanks-later" data-testid="paid-thanks-later">
          {translate('ui.thanks.later')}
        </p>
      ) : null}
      <p className="paid-thanks-free">{translate('ui.cta.freeNote')}</p>
    </div>
  )
}
