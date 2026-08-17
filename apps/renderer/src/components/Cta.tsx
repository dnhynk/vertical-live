import type { Translate } from '../i18n/index'
import { commandLabel, type CtaState } from '../read-model/cta'

/**
 * The free-command call to action (spec §5.2(3)).
 *
 * When the server reports `interactionEnabled: false` — input or renderer ACK
 * unhealthy — the CTA disappears and the screen says 相互作用一時停止 instead
 * (spec §9.2). The renderer never decides this itself.
 */
export interface CtaProps {
  cta: CtaState
  translate: Translate
}

export default function Cta({ cta, translate }: CtaProps) {
  if (!cta.enabled) {
    return (
      <div className="cta cta-paused" data-testid="interaction-paused">
        {translate('ui.interactionPaused')}
      </div>
    )
  }

  return (
    <div className="cta" data-testid="cta" data-cta-source={cta.source}>
      <h2 className="slot-label">{translate('ui.cta.title')}</h2>
      <ul className="cta-commands">
        {cta.commands.map((name) => {
          const label = commandLabel(name)
          return (
            <li key={name} className="cta-command" data-testid={`cta-command-${name}`}>
              <span className="cta-icon">{label.icon ?? ''}</span>
              <span className="cta-text">{label.label}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
