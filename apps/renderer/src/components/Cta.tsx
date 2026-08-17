import type { Alias, Translate } from '../i18n/index'
import { commandLabel, type CtaState } from '../read-model/cta'
import Icon from '../visual/icons'

/**
 * The free-command call to action (spec §5.2(3), §7.1) and the open decision
 * (spec §6.2, §6.4).
 *
 * Three things this component must keep saying:
 *
 * - what to type, in the three forms §7.1 accepts (Japanese, emoji, English), so
 *   a viewer can act without learning anything;
 * - that everything is reachable for free (spec §8.5) — the note sits with the
 *   CTA, not only next to a paid surface, and nothing on this screen offers a
 *   paid alternative to it;
 * - nothing at all, when the server reports `interactionEnabled: false`. Input or
 *   renderer ACK is unhealthy then, so the CTA disappears and the screen shows
 *   `ui.interactionPaused` instead (spec §9.2). The renderer never decides this
 *   itself.
 */
export interface CtaProps {
  cta: CtaState
  translate: Translate
  alias: Alias
}

export default function Cta({ cta, translate, alias }: CtaProps) {
  if (!cta.enabled) {
    return (
      <div className="cta cta-paused" data-testid="interaction-paused">
        <p className="cta-paused-title">{translate('ui.interactionPaused')}</p>
        <p className="cta-paused-note">{translate('ui.interactionPausedNote')}</p>
      </div>
    )
  }

  return (
    <div className="cta" data-testid="cta">
      {cta.choice === null ? null : (
        <ul className="cta-choices" data-testid="cta-choices">
          {cta.choice.options.map((option) => (
            <li className="cta-choice" key={option.choiceId} data-testid={`choice-${option.choiceId}`}>
              {option.commandName === null ? null : (
                <span className="cta-choice-key">{commandLabel(option.commandName).en}</span>
              )}
              <span className="cta-choice-text">{translate(option.labelKey)}</span>
              <span className="cta-choice-en">{alias(option.labelKey)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="cta-head">
        <h2 className="slot-label">
          <span className="slot-label-ja">{translate('ui.cta.title')}</span>
          <span className="slot-label-en">{alias('ui.cta.title')}</span>
        </h2>
        <span className="cta-hint">{translate('ui.cta.hint')}</span>
      </div>

      <ul className="cta-commands">
        {cta.commands.map((name) => {
          const label = commandLabel(name)
          return (
            <li key={name} className="cta-command" data-testid={`cta-command-${name}`}>
              {label.iconId === null ? null : (
                <Icon iconId={label.iconId} className="icon-command" />
              )}
              <span className="cta-text">{label.ja ?? label.en}</span>
              {label.emoji === null ? null : <span className="cta-emoji">{label.emoji}</span>}
              <span className="cta-en">{label.en}</span>
            </li>
          )
        })}
      </ul>

      <p className="cta-free-note" data-testid="cta-free-note">
        {translate('ui.cta.freeNote')}
      </p>
    </div>
  )
}
