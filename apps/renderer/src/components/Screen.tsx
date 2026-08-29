import type { CSSProperties } from 'react'

import { useReadModel, useTick } from '../hooks'
import { selectCta } from '../read-model/cta'
import { selectMode, selectSlots } from '../read-model/display'
import { selectActionActorName } from '../read-model/identity'
import type { RendererRuntime } from '../runtime'
import { paletteFor } from '../visual/palette'
import { safeAreaCssVariables } from '../visual/safe-area'
import Cta from './Cta'
import DevPanel from './DevPanel'
import EffectLayer from './EffectLayer'
import { HudBottom, HudTop, HudWaiting } from './Hud'
import ModeBadge from './ModeBadge'

/**
 * Everything the renderer draws in the DOM layer of the 1080x1920 stage.
 *
 * This component owns the read-model subscription, so its commit is what marks
 * a revision as rendered; the frame loop then acknowledges it (spec §7.3(7)).
 *
 * The layout answers spec §5.2 inside the band `visual/safe-area.ts` measures —
 * the rows of the frame the YouTube app does not draw its own UI over. Reading
 * order there is not top to bottom but centre then floor: the creature and
 * whatever is playing around it hold the middle, the three secondary slots run
 * down the right column, and the current need and the free commands share one
 * plate at the band's floor, immediately above the app's real chat input.
 *
 * The name of a consented viewer is the one value the DOM layer joins from two
 * messages: the slot's action comes from the snapshot and the name from the
 * effect that staged it, because the snapshot deliberately carries no name
 * (BOARD D-9, T20a). The key of that join is the commit both messages came from,
 * which the read model carries as `actionRevision`; `read-model/identity.ts`
 * owns the join and is the only module allowed to read `actor`.
 */
export interface ScreenProps {
  runtime: RendererRuntime
}

/**
 * The countdowns are derived from absolute instants in the snapshot, so the
 * screen re-reads the clock once a second rather than storing a ticking value.
 * Provisional (BOARD A-15): a display cadence, not an acceptance threshold.
 */
export const COUNTDOWN_TICK_MS = 1_000

export default function Screen({ runtime }: ScreenProps) {
  const { snapshot, activeEffects, actionRevision } = useReadModel(runtime.model)
  useTick(COUNTDOWN_TICK_MS)

  const { translate, alias } = runtime
  const nowMs = runtime.clock.wallMs()
  const palette = paletteFor(snapshot)
  const cta = selectCta(snapshot)

  return (
    <div
      className="screen"
      data-testid="screen"
      data-mode={runtime.config.mode}
      data-palette={palette.paletteId}
      style={{ ...safeAreaCssVariables(), '--accent': palette.accent } as CSSProperties}
    >
      {snapshot === null ? (
        <HudWaiting translate={translate} />
      ) : (
        <>
          <div className="screen-top">
            <ModeBadge mode={selectMode(snapshot, nowMs)} translate={translate} alias={alias} />
          </div>
          <HudBottom
            slots={selectSlots(snapshot, nowMs)}
            translate={translate}
            alias={alias}
            actorName={selectActionActorName(snapshot, activeEffects, actionRevision)}
          />
        </>
      )}

      <EffectLayer effects={activeEffects} translate={translate} alias={alias} />

      {snapshot === null ? null : (
        <div className="screen-foot">
          <HudTop slots={selectSlots(snapshot, nowMs)} translate={translate} alias={alias} />
          <Cta cta={cta} translate={translate} alias={alias} />
        </div>
      )}

      {runtime.config.mode === 'dev' ? <DevPanel runtime={runtime} /> : null}
    </div>
  )
}
