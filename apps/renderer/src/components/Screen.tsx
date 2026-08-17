import { useReadModel } from '../hooks'
import { selectCta } from '../read-model/cta'
import type { RendererRuntime } from '../runtime'
import Cta from './Cta'
import DevPanel from './DevPanel'
import EffectLayer from './EffectLayer'
import Hud from './Hud'

/**
 * Everything the renderer draws in the DOM layer of the 1080x1920 stage.
 *
 * This component owns the read-model subscription, so its commit is what marks
 * a revision as rendered; the frame loop then acknowledges it (spec §7.3(7)).
 */
export interface ScreenProps {
  runtime: RendererRuntime
}

export default function Screen({ runtime }: ScreenProps) {
  const { snapshot, activeEffects } = useReadModel(runtime.model)
  const cta = selectCta(snapshot)

  return (
    <div className="screen" data-testid="screen" data-mode={runtime.config.mode}>
      <Hud snapshot={snapshot} translate={runtime.translate} />
      <EffectLayer effects={activeEffects} />
      <Cta cta={cta} translate={runtime.translate} />
      {runtime.config.mode === 'dev' ? <DevPanel runtime={runtime} /> : null}
    </div>
  )
}
