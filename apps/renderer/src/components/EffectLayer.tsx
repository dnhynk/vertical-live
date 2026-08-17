import type { Effect } from '@vl/contract'

import type { Alias, Translate } from '../i18n/index'
import { commandLabel } from '../read-model/cta'
import Icon from '../visual/icons'
import PaidThanks from './PaidThanks'

/**
 * Currently playing effects (spec §7.3(6)). Each `effectId` is started once by
 * the read model, so a resend re-renders nothing here.
 *
 * The layer takes effects and text functions — never a snapshot — so the paid
 * staging path cannot reach world state (TASK_SPECS §T14 acceptance 3). The four
 * kinds get four places on screen: an ambience wash behind everything, the
 * mission beat and the paid acknowledgement in the middle where they are read,
 * and free-command reactions as chips beside the creature.
 */
export interface EffectLayerProps {
  effects: readonly Effect[]
  translate: Translate
  alias: Alias
}

const MISSION_PHASE_KEYS = {
  STARTED: 'ui.mission.started',
  PROGRESS: 'ui.mission.progress',
  COMPLETED: 'ui.mission.completed',
} as const

/**
 * The family of an ambience id, i.e. the part before its first underscore. The
 * content director owns the vocabulary (T7), so the staging keys off the family
 * and an unknown one simply gets the neutral wash.
 */
function ambienceFamily(ambienceId: string): string {
  const [family] = ambienceId.split('_')
  return family === undefined || family === '' ? 'unknown' : family
}

export default function EffectLayer({ effects, translate, alias }: EffectLayerProps) {
  const ambience = effects.filter((effect) => effect.kind === 'AMBIENCE')
  const reactions = effects.filter((effect) => effect.kind === 'ACTION_REACTION')
  const missions = effects.filter((effect) => effect.kind === 'MISSION_UPDATE')
  const paid = effects.filter((effect) => effect.kind === 'PAID_THANKS')

  return (
    <div className="effect-layer" data-testid="effect-layer">
      <div className="effect-ambience-layer" aria-hidden="true">
        {ambience.map((effect) => (
          <div
            key={effect.effectId}
            className="effect effect-ambience"
            data-testid={`effect-${effect.effectId}`}
            data-ambience={effect.payload.ambienceId}
            data-ambience-family={ambienceFamily(effect.payload.ambienceId)}
          />
        ))}
      </div>

      <div className="effect-center">
        {missions.map((effect) => (
          <div
            key={effect.effectId}
            className="effect effect-mission"
            data-testid={`effect-${effect.effectId}`}
            data-phase={effect.payload.phase}
          >
            <span className="effect-mission-phase">
              {translate(MISSION_PHASE_KEYS[effect.payload.phase])}
            </span>
            <span className="effect-mission-name">
              {translate(`mission.${effect.payload.missionId}`)}
            </span>
            <span className="effect-mission-en">
              {alias(`mission.${effect.payload.missionId}`)}
            </span>
          </div>
        ))}

        {paid.map((effect) => (
          <div
            key={effect.effectId}
            className="effect effect-paid"
            data-testid={`effect-${effect.effectId}`}
          >
            <PaidThanks
              paidEventKind={effect.payload.paidEventKind}
              iconId={effect.payload.iconId}
              fallback={effect.payload.fallback}
              translate={translate}
              alias={alias}
            />
          </div>
        ))}
      </div>

      <div className="effect-chips">
        {reactions.map((effect) => {
          const label = commandLabel(effect.payload.commandName)
          return (
            <div
              key={effect.effectId}
              className="effect effect-reaction"
              data-testid={`effect-${effect.effectId}`}
            >
              {label.iconId === null ? null : (
                <Icon iconId={label.iconId} className="icon-reaction" />
              )}
              <span className="effect-reaction-text">{label.ja ?? label.en}</span>
              <span className="effect-reaction-count">
                {translate('ui.contributions', { count: effect.payload.contributionCount })}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
