import { useLayoutEffect, useState, type ReactNode } from 'react'

import { STAGE_HEIGHT, STAGE_WIDTH } from '../config'
import { computeStageScale } from '../stage'

/**
 * Fixed 9:16 1080x1920 stage (spec §11 "화면"). Only the CSS scale reacts to the
 * window; the layout inside is always 1080x1920, which is the size OBS opens the
 * Browser Source at.
 */
export interface StageProps {
  children: ReactNode
}

export default function Stage({ children }: StageProps) {
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const apply = (): void => {
      setScale(computeStageScale(window.innerWidth, window.innerHeight))
    }
    apply()
    window.addEventListener('resize', apply)
    return () => {
      window.removeEventListener('resize', apply)
    }
  }, [])

  return (
    <div className="app-shell">
      <div
        className="stage"
        data-testid="stage"
        style={{
          width: `${STAGE_WIDTH}px`,
          height: `${STAGE_HEIGHT}px`,
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  )
}
