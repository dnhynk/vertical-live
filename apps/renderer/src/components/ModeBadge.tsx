import type { Alias, Translate } from '../i18n/index'
import { commandLabel } from '../read-model/cta'
import { formatDuration, type ModeView } from '../read-model/display'
import Icon from '../visual/icons'

/**
 * Current input mode, and while an aggregate window is open its remaining time
 * and its tally (spec §6.4: "전환 중에는 현재 모드, 남은 시간, 집계 결과를 화면에
 * 표시한다").
 *
 * The counts are room totals. Nothing here claims per-user fairness, and there
 * is no participant to name (BOARD A-1): the tally is a command and a number.
 */
export interface ModeBadgeProps {
  mode: ModeView
  translate: Translate
  alias: Alias
}

export default function ModeBadge({ mode, translate, alias }: ModeBadgeProps) {
  const remaining = mode.remainingMs

  return (
    <div className="mode-badge" data-testid="mode-badge" data-mode={mode.mode}>
      <div className="mode-head">
        <span className="mode-label">{translate('ui.mode.label')}</span>
        <span className="mode-value">{translate(mode.labelKey)}</span>
        <span className="mode-alias">{alias(mode.labelKey)}</span>
        {mode.windowOpen && remaining !== null ? (
          <span className="mode-remaining" data-testid="mode-remaining">
            {translate('ui.remaining', { duration: formatDuration(remaining, translate) })}
          </span>
        ) : null}
      </div>

      {mode.windowOpen && mode.tallies.length > 0 ? (
        <ul className="mode-tallies" data-testid="mode-tallies">
          {mode.tallies.map((tally) => {
            const label = commandLabel(tally.commandName)
            return (
              <li className="mode-tally" key={tally.commandName}>
                {label.iconId === null ? (
                  <span className="tally-letter">{label.en}</span>
                ) : (
                  <Icon iconId={label.iconId} className="icon-tally" />
                )}
                <span className="tally-bar">
                  <span className="tally-fill" style={{ width: `${tally.share * 100}%` }} />
                </span>
                <span className="tally-count" data-testid={`tally-${tally.commandName}`}>
                  {translate('ui.contributions', { count: tally.count })}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
