import type { Effect } from '@vl/contract'

import { commandLabel } from '../read-model/cta'

/**
 * Currently playing effects (spec §7.3(6)). Each `effectId` is started once by
 * the read model, so a resend re-renders nothing here.
 *
 * A paid thanks effect shows the anonymous icon the server chose and never a
 * supporter name (spec §12.3), and carries no game power (spec §8.5). The full
 * staging is T14; this layer proves the transport and the idempotency.
 */
export interface EffectLayerProps {
  effects: readonly Effect[]
}

function effectText(effect: Effect): string {
  switch (effect.kind) {
    case 'ACTION_REACTION': {
      const label = commandLabel(effect.payload.commandName)
      return `${label.icon ?? ''}${label.label} x${effect.payload.contributionCount}`
    }
    case 'PAID_THANKS':
      return `${effect.payload.iconId}${effect.payload.fallback ? ' (fallback)' : ''}`
    case 'AMBIENCE':
      return effect.payload.ambienceId
    case 'MISSION_UPDATE':
      return `${effect.payload.missionId}:${effect.payload.phase}`
  }
}

export default function EffectLayer({ effects }: EffectLayerProps) {
  return (
    <div className="effect-layer" data-testid="effect-layer">
      {effects.map((effect) => (
        <div
          key={effect.effectId}
          className={`effect effect-${effect.kind.toLowerCase()}`}
          data-testid={`effect-${effect.effectId}`}
        >
          {effectText(effect)}
        </div>
      ))}
    </div>
  )
}
