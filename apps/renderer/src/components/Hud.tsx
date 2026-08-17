import type { WorldSnapshot } from '@vl/contract'

import { formatJstTime, type Translate } from '../i18n/index'
import { commandLabel } from '../read-model/cta'

/**
 * The four fixed information slots of spec §5.2, drawn from `snapshot.display`
 * and from nothing else.
 *
 * There is no raw chat and no name anywhere on this screen (spec §12.3): the
 * display fields carry i18n keys, identifiers and counts only, and the renderer
 * has no field it could put a person's name in.
 */
export interface HudProps {
  snapshot: WorldSnapshot | null
  translate: Translate
}

export default function Hud({ snapshot, translate }: HudProps) {
  if (snapshot === null) {
    return (
      <div className="hud hud-waiting" data-testid="hud-waiting">
        {translate('ui.waiting')}
      </div>
    )
  }

  const display = snapshot.display
  const action = display.lastAppliedAction
  const actionLabel = action === null ? null : commandLabel(action.commandName)
  const progress = display.growthOrChapterProgress.progress
  const progressRatio = Math.max(0, Math.min(1, progress.current / progress.target))

  return (
    <div className="hud" data-testid="hud">
      <section className="slot slot-need" data-testid="slot-need">
        <h2 className="slot-label">{translate('ui.slot.needOrMission')}</h2>
        <p className="slot-value">
          <span className="slot-icon" data-testid="slot-need-icon">
            {display.currentNeedOrMission.iconId}
          </span>
          <span className="slot-text">{translate(display.currentNeedOrMission.textKey)}</span>
        </p>
      </section>

      <section className="slot slot-last-action" data-testid="slot-last-action">
        <h2 className="slot-label">{translate('ui.slot.lastAction')}</h2>
        <p className="slot-value">
          {action === null || actionLabel === null ? (
            <span className="slot-text">{translate('ui.none')}</span>
          ) : (
            <>
              <span className="slot-icon">{actionLabel.icon ?? ''}</span>
              <span className="slot-text">{actionLabel.label}</span>
              <span className="slot-count" data-testid="slot-last-action-count">
                {translate('ui.contributions', { count: action.contributionCount })}
              </span>
              <span className="slot-time">
                {translate('ui.jst', { time: formatJstTime(action.appliedAt) })}
              </span>
            </>
          )}
        </p>
      </section>

      <section className="slot slot-progress" data-testid="slot-progress">
        <h2 className="slot-label">{translate('ui.slot.progress')}</h2>
        <p className="slot-value">
          <span className="slot-text">{translate(display.growthOrChapterProgress.textKey)}</span>
          <span className="slot-count">
            {translate('ui.progressValue', {
              current: progress.current,
              target: progress.target,
            })}
          </span>
        </p>
        <div className="progress-track" data-testid="slot-progress-bar">
          <div className="progress-fill" style={{ width: `${progressRatio * 100}%` }} />
        </div>
      </section>

      <section className="slot slot-next-choice" data-testid="slot-next-choice">
        <h2 className="slot-label">{translate('ui.slot.nextChoice')}</h2>
        <p className="slot-value">
          <span className="slot-text">
            {display.nextChoiceAt === null
              ? translate('ui.undecided')
              : translate('ui.jst', { time: formatJstTime(display.nextChoiceAt) })}
          </span>
        </p>
      </section>
    </div>
  )
}
