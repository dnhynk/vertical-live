import { STAGE_HEIGHT, STAGE_WIDTH } from '../config'

/**
 * Where YouTube's own UI sits on top of our 1080x1920 frame, and what is left.
 *
 * The surface this models is the **YouTube app's regular watch page** showing a
 * vertical live stream, in the collapsed state — the surface BOARD D-23/D-24 and
 * the Gate 2 calibration actually target. It is *not* Shorts: Shorts draws a
 * like/share/comment column down the right edge and the watch page does not, and
 * an earlier version of this file reserved 120px on the right for a column that
 * is never there while leaving content in the bottom 160px that the chat overlay
 * always covers.
 *
 * Provenance: measured off one device screenshot (2026-08-29, iOS app, 924x1912).
 * The 9:16 video is fitted to the screen width, so the video occupies screen rows
 * 134..1777 (1643 tall) and the conversion to broadcast pixels is
 * `(screenY - 134) * 1920 / 1643`.
 *
 * `provisional` in the BOARD A-15 sense (see A-T53-1): one screenshot, one
 * device. Header height and chat overlay start move with device, OS and the
 * viewer's text size setting. These are placement inputs, not pass marks — D-25
 * puts their confirmation in the real public broadcast.
 */
export interface Rect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** Rows and regions of the frame that YouTube's chrome draws over. */
export const YOUTUBE_WATCH_OCCLUSION = {
  /** Back arrow, channel row, viewer/like counts, subscribe, overflow — plus the scrim under them. */
  headerBottom: 195,
  /** Where the live chat overlay's lowest message sits when chat is busy. Intermittent: it moves with message count. */
  chatOverlayTop: 1310,
  /** The "welcome to live chat" banner. Always drawn while chat is open. */
  bannerTop: 1678,
  /** The chat input row. Always drawn. */
  chatInputTop: 1827,
  /** Gift and effect labels. Only present while gifts are arriving, and text-free on our side is enough (A-T53-2). */
  giftLabels: { left: 41, right: 386, top: 258, bottom: 778 } satisfies Rect,
  /** The channel's crown badge. */
  crownBadge: { left: 47, right: 117, top: 106, bottom: 174 } satisfies Rect,
} as const

/**
 * The band our own screen is allowed to use.
 *
 * The floor is `chatOverlayTop`, not `bannerTop`: the banner and the input row
 * are the only *always* occluded rows, but content that a busy chat covers half
 * the time fails spec §5.2 just as surely as content that is always covered, and
 * §5.2 is a five-second test on a first view we do not get to retry.
 */
export const SAFE_BAND = {
  top: YOUTUBE_WATCH_OCCLUSION.headerBottom,
  bottom: YOUTUBE_WATCH_OCCLUSION.chatOverlayTop,
} as const

/** Side margin inside the band. The watch page occludes neither edge. */
export const SAFE_INSET_X = 44

/** Width of the right-hand column that carries the three secondary slots. */
export const RAIL_WIDTH = 360

/**
 * Where the standing consent disclosure sits: below the band, in the rows the
 * chat overlay covers only while chat is busy, and above the banner that is
 * always drawn.
 *
 * This is a deliberate demotion. Everything spec §5.2 asks a first-time viewer to
 * read in five seconds stays fully clear of the app's UI; the disclosure is not
 * one of those four things — under BOARD D-9 the screen carries a one-line
 * summary and the channel description carries the full text — and the band is not
 * tall enough to hold both at a size either of them can be read at.
 */
export const NOTICE_TOP = YOUTUBE_WATCH_OCCLUSION.chatOverlayTop + 16
export const NOTICE_BOTTOM = YOUTUBE_WATCH_OCCLUSION.bannerTop - 16

/** Distance from the band's centre to the frame's centre, in broadcast pixels. */
export function bandCentreOffset(): number {
  return STAGE_HEIGHT / 2 - (SAFE_BAND.top + SAFE_BAND.bottom) / 2
}

/**
 * The custom properties `index.css` lays the screen out with. Kept here rather
 * than in the stylesheet so the numbers sit next to the measurement they came
 * from; the stylesheet consumes them and never restates them.
 */
export function safeAreaCssVariables(): Record<string, string> {
  return {
    '--safe-top': `${SAFE_BAND.top}px`,
    '--safe-bottom-inset': `${STAGE_HEIGHT - SAFE_BAND.bottom}px`,
    '--safe-inset-x': `${SAFE_INSET_X}px`,
    '--rail-width': `${RAIL_WIDTH}px`,
    '--notice-top': `${NOTICE_TOP}px`,
    '--notice-max-height': `${NOTICE_BOTTOM - NOTICE_TOP}px`,
  }
}

/** True when `rect` stays clear of everything YouTube draws over. */
export function withinSafeBand(rect: Rect): boolean {
  return (
    rect.top >= SAFE_BAND.top &&
    rect.bottom <= SAFE_BAND.bottom &&
    rect.left >= 0 &&
    rect.right <= STAGE_WIDTH
  )
}
