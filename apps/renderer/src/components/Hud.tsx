import { formatJstTime, type Alias, type Translate } from '../i18n/index'
import { commandLabel } from '../read-model/cta'
import { formatDuration, type SlotViews } from '../read-model/display'
import Icon from '../visual/icons'

/**
 * The four fixed information slots of spec §5.2, drawn from `snapshot.display`
 * and from nothing else, each as Japanese wording + icon + short English alias
 * (spec §5.1, §5.3).
 *
 * What is deliberately *not* here: the internal values behind the progress. Spec
 * §5.2 limits the screen to the four questions and forbids listing the world's
 * numbers, so growth arrives as a bar and the chapter as three beat marks. The
 * numbers that remain are participation counts, which spec §7.3 requires to be
 * preserved, and a clock time.
 *
 * There is no raw chat here (spec §12.3): the display fields carry i18n keys,
 * identifiers and counts only, and no message text reaches this file.
 *
 * The one thing a viewer can put on this screen is their own name, in the "just
 * applied action" slot and only after opting in (BOARD D-9). It arrives as an
 * already-selected, already-shortened string — `read-model/identity.ts` decides
 * whether an action may be named at all — and is drawn as a React text node,
 * which is why nothing here escapes, parses or injects anything.
 */

export interface HudProps {
  slots: SlotViews
  translate: Translate
  alias: Alias
}

export interface HudBottomProps extends HudProps {
  /**
   * Display name of the consented viewer whose action the slot is showing, or
   * `null` — which is every viewer until they opt in, every viewer again after
   * they withdraw, and any case where the join was not certain (BOARD D-9).
   */
  actorName: string | null
}

function SlotLabel({
  labelKey,
  translate,
  alias,
}: {
  labelKey: string
  translate: Translate
  alias: Alias
}) {
  const short = alias(labelKey)
  return (
    <h2 className="slot-label">
      <span className="slot-label-ja">{translate(labelKey)}</span>
      {short === null ? null : <span className="slot-label-en">{short}</span>}
    </h2>
  )
}

/** Slot 1: what the creature needs or what the room is working on, made big. */
export function HudTop({ slots, translate, alias }: HudProps) {
  const need = slots.need
  const short = alias(need.textKey)

  return (
    <section className="slot slot-need" data-testid="slot-need">
      <SlotLabel labelKey={need.labelKey} translate={translate} alias={alias} />
      <p className="slot-value">
        <Icon iconId={need.iconId} className="icon-need" />
        <span className="slot-text" data-testid="slot-need-text">
          {translate(need.textKey)}
        </span>
      </p>
      {short === null ? null : <p className="slot-en">{short}</p>}
    </section>
  )
}

/** Slots 2–4: the last applied action, the progress, and the next decision. */
export function HudBottom({ slots, translate, alias, actorName }: HudBottomProps) {
  const { action, progress, nextChoice } = slots
  const label = action.commandName === null ? null : commandLabel(action.commandName)
  const beats = Array.from({ length: progress.beatCount }, (_unused, index) => index)

  return (
    <div className="hud" data-testid="hud">
      <section className="slot slot-last-action" data-testid="slot-last-action">
        <SlotLabel labelKey={action.labelKey} translate={translate} alias={alias} />
        {label === null || action.appliedAt === null ? (
          <p className="slot-value">
            <span className="slot-text">{translate('ui.none')}</span>
          </p>
        ) : (
          <p className="slot-value">
            {label.iconId === null ? null : <Icon iconId={label.iconId} className="icon-action" />}
            <span className="slot-text">{label.ja ?? label.en}</span>
            <span className="slot-en-inline">{label.en}</span>
            {actorName === null ? null : (
              <span className="slot-actor" data-testid="slot-last-action-actor">
                {actorName}
              </span>
            )}
            <span className="slot-count" data-testid="slot-last-action-count">
              {translate('ui.contributions', { count: action.contributionCount })}
            </span>
            <span className="slot-time">
              {translate('ui.jst', { time: formatJstTime(action.appliedAt) })}
            </span>
          </p>
        )}
      </section>

      <section className="slot slot-progress" data-testid="slot-progress">
        <SlotLabel labelKey={progress.labelKey} translate={translate} alias={alias} />
        <p className="slot-value">
          <span className="slot-text">{translate(progress.textKey)}</span>
          <span className="slot-en-inline">{alias(progress.textKey)}</span>
          <span className="slot-stage" data-testid="slot-progress-stage">
            {translate(progress.stageTextKey)}
          </span>
        </p>
        <div className="progress-track" data-testid="slot-progress-bar">
          <div className="progress-fill" style={{ width: `${progress.ratio * 100}%` }} />
        </div>
        <ol className="beat-marks" data-testid="slot-progress-beats">
          {beats.map((beat) => (
            <li
              key={beat}
              className={beat < progress.beatsPlayed ? 'beat beat-played' : 'beat'}
              aria-hidden="true"
            />
          ))}
        </ol>
      </section>

      <section className="slot slot-next-choice" data-testid="slot-next-choice">
        <SlotLabel labelKey={nextChoice.labelKey} translate={translate} alias={alias} />
        <p className="slot-value">
          {nextChoice.at === null || nextChoice.remainingMs === null ? (
            <span className="slot-text">{translate('ui.undecided')}</span>
          ) : (
            <>
              <span className="slot-text" data-testid="slot-next-choice-remaining">
                {translate('ui.remaining', {
                  duration: formatDuration(nextChoice.remainingMs, translate),
                })}
              </span>
              <span className="slot-time">
                {translate('ui.jst', { time: formatJstTime(nextChoice.at) })}
              </span>
            </>
          )}
        </p>
      </section>
    </div>
  )
}

/** Before the first snapshot the screen says so instead of inventing a state. */
export function HudWaiting({ translate }: { translate: Translate }) {
  return (
    <div className="hud hud-waiting" data-testid="hud-waiting">
      {translate('ui.waiting')}
    </div>
  )
}
