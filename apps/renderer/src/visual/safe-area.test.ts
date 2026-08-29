import { describe, expect, it } from 'vitest'

import { STAGE_HEIGHT, STAGE_WIDTH } from '../config'
import {
  NOTICE_BOTTOM,
  NOTICE_TOP,
  RAIL_WIDTH,
  SAFE_BAND,
  SAFE_INSET_X,
  YOUTUBE_WATCH_OCCLUSION,
  bandCentreOffset,
  safeAreaCssVariables,
  withinSafeBand,
} from './safe-area'

describe('safe area', () => {
  it('leaves a usable band between the two things YouTube always draws', () => {
    expect(SAFE_BAND.top).toBeLessThan(SAFE_BAND.bottom)
    expect(SAFE_BAND.bottom - SAFE_BAND.top).toBeGreaterThan(0)
  })

  it('stops above the chat overlay, not merely above the always-on rows', () => {
    // Regression for the layout T53 replaced: it ended at 1460px, which is inside
    // the overlay. Stopping at `bannerTop` or `chatInputTop` would repeat that.
    expect(SAFE_BAND.bottom).toBe(YOUTUBE_WATCH_OCCLUSION.chatOverlayTop)
    expect(SAFE_BAND.bottom).toBeLessThan(YOUTUBE_WATCH_OCCLUSION.bannerTop)
    expect(SAFE_BAND.bottom).toBeLessThan(YOUTUBE_WATCH_OCCLUSION.chatInputTop)
  })

  it('reserves no right-hand column: the watch page has none, only Shorts does', () => {
    expect(SAFE_INSET_X + RAIL_WIDTH).toBeLessThan(STAGE_WIDTH)
    const rail = {
      left: STAGE_WIDTH - SAFE_INSET_X - RAIL_WIDTH,
      right: STAGE_WIDTH - SAFE_INSET_X,
      top: SAFE_BAND.top,
      bottom: SAFE_BAND.bottom,
    }
    expect(withinSafeBand(rail)).toBe(true)
    // The rail reaches the frame's right margin; nothing is held back for a
    // like/share/comment column.
    expect(rail.right).toBe(STAGE_WIDTH - SAFE_INSET_X)
  })

  it('rejects a rect that reaches into the header or the chat overlay', () => {
    const underHeader = { left: 44, right: 1036, top: 100, bottom: 400 }
    const underChat = { left: 44, right: 1036, top: 1000, bottom: 1500 }
    expect(withinSafeBand(underHeader)).toBe(false)
    expect(withinSafeBand(underChat)).toBe(false)
  })

  it('reports how far the band centre sits above the frame centre', () => {
    // The scene is centred on the frame; the screen is centred on the band. The
    // offset is what Scene lifts the creature by so its head clears the header.
    expect(bandCentreOffset()).toBeCloseTo(
      STAGE_HEIGHT / 2 - (SAFE_BAND.top + SAFE_BAND.bottom) / 2,
      6,
    )
    expect(bandCentreOffset()).toBeGreaterThan(0)
  })

  it('puts the consent disclosure below the band but above the always-on banner', () => {
    expect(NOTICE_TOP).toBeGreaterThan(SAFE_BAND.bottom)
    expect(NOTICE_BOTTOM).toBeLessThan(YOUTUBE_WATCH_OCCLUSION.bannerTop)
    expect(NOTICE_BOTTOM - NOTICE_TOP).toBeGreaterThan(0)
  })

  it('publishes the band as the custom properties the stylesheet consumes', () => {
    expect(safeAreaCssVariables()).toEqual({
      '--safe-top': `${SAFE_BAND.top}px`,
      '--safe-bottom-inset': `${STAGE_HEIGHT - SAFE_BAND.bottom}px`,
      '--safe-inset-x': `${SAFE_INSET_X}px`,
      '--rail-width': `${RAIL_WIDTH}px`,
      '--notice-top': `${NOTICE_TOP}px`,
      '--notice-max-height': `${NOTICE_BOTTOM - NOTICE_TOP}px`,
    })
  })
})
