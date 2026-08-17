import { STAGE_HEIGHT, STAGE_WIDTH } from './config'

/**
 * The stage is a fixed 1080x1920 coordinate system (spec §11 "화면"): OBS opens
 * the Browser Source at exactly that size, so the scale is 1 on air. A smaller
 * developer window only changes the CSS scale, never the layout, so what is
 * measured in a test is what is broadcast.
 */
export function computeStageScale(
  viewportWidth: number,
  viewportHeight: number,
  stageWidth: number = STAGE_WIDTH,
  stageHeight: number = STAGE_HEIGHT,
): number {
  if (viewportWidth <= 0 || viewportHeight <= 0) return 1
  return Math.min(viewportWidth / stageWidth, viewportHeight / stageHeight)
}
