import type { ReactElement } from 'react'

/**
 * The screen's icon set (spec §5.1: Japanese wording, then an icon and a short
 * English alias).
 *
 * Every glyph below is geometry written in this repository — no third-party
 * icon font, no downloaded asset, nothing whose rights are unclear (spec §12.1,
 * CLAUDE.md §3). `ASSETS.md` records the set. They are deliberately plain
 * shapes: a bowl, a ball, a heart, a moon, a badge — a silhouette that could be
 * mistaken for someone else's character is exactly what the spec forbids.
 *
 * `iconId` is the world's identifier (T7 emits `icon_need_*` and `icon_crisis_*`
 * for the fixed slot and `thanks_*` for a paid acknowledgement). An identifier
 * this file has not caught up with draws the neutral fallback instead of
 * blanking the slot.
 */

const FALLBACK_ICON_ID = 'icon_fallback'

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const bowl: ReactElement = (
  <>
    <path d="M2.5 11h19a9.5 9.5 0 0 1-19 0z" fill="currentColor" />
    <path
      d="M8 7.6c0-1.4 1.4-1.4 1.4-2.9M12 6.6c0-1.4 1.4-1.4 1.4-2.9M16 7.6c0-1.4 1.4-1.4 1.4-2.9"
      {...STROKE}
    />
  </>
)

const ball: ReactElement = (
  <>
    <circle cx="12" cy="12" r="8" {...STROKE} />
    <path d="M5.2 9.2c4.4 2.1 9.2 2.1 13.6 0M5.2 14.8c4.4-2.1 9.2-2.1 13.6 0" {...STROKE} />
  </>
)

const heart: ReactElement = (
  <path
    d="M12 20.2C8.4 17.7 4.6 14.7 4.6 11.1A4.1 4.1 0 0 1 12 8.6a4.1 4.1 0 0 1 7.4 2.5c0 3.6-3.8 6.6-7.4 9.1z"
    fill="currentColor"
  />
)

const moon: ReactElement = (
  <path d="M18 15.6A7.2 7.2 0 0 1 9.2 6.1a7.6 7.6 0 1 0 8.8 9.5z" fill="currentColor" />
)

const ICONS: Readonly<Record<string, ReactElement>> = {
  icon_need_hungry: bowl,
  icon_need_play: ball,
  icon_need_affection: heart,
  icon_need_rest: moon,

  icon_command_feed: bowl,
  icon_command_play: ball,
  icon_command_pet: heart,

  icon_crisis_sleeping: (
    <>
      {moon}
      <path d="M14.6 4.4h3.8l-3.8 3.9h3.8" {...STROKE} />
    </>
  ),
  icon_crisis_tired: (
    <>
      <circle cx="12" cy="12" r="8.4" {...STROKE} />
      <path
        d="M7.4 10.6c1-1 2.4-1 3.4 0M13.2 10.6c1-1 2.4-1 3.4 0M8.6 16.2c2-1.6 4.8-1.6 6.8 0"
        {...STROKE}
      />
    </>
  ),
  icon_crisis_needs_help: (
    <>
      <circle cx="12" cy="12" r="8.4" {...STROKE} />
      <path d="M12 7.4v5.4" {...STROKE} />
      <circle cx="12" cy="16.4" r="1.15" fill="currentColor" />
    </>
  ),

  thanks_super_chat: (
    <path
      d="M4.2 4.8h15.6a1.7 1.7 0 0 1 1.7 1.7v7.8a1.7 1.7 0 0 1-1.7 1.7h-6.6L8.4 19.6v-3.6H4.2a1.7 1.7 0 0 1-1.7-1.7V6.5a1.7 1.7 0 0 1 1.7-1.7z"
      fill="currentColor"
    />
  ),
  thanks_super_sticker: (
    <>
      <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="4.6" {...STROKE} />
      <path
        d="M12 7.4l1.5 2.9 3.1.6-2.3 2.2.5 3.1-2.8-1.5-2.8 1.5.5-3.1-2.3-2.2 3.1-.6z"
        fill="currentColor"
      />
    </>
  ),
  thanks_gift: (
    <>
      <path d="M2.6 6.6h18.8v3.6H2.6z" fill="currentColor" />
      <path d="M4.4 10.2h15.2v9.4a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1z" {...STROKE} />
      <path
        d="M12 6.6v14M12 6.6C10.4 3.9 6.6 3.1 7.1 6.6M12 6.6c1.6-2.7 5.4-3.5 4.9 0"
        {...STROKE}
      />
    </>
  ),
  thanks_membership: (
    <>
      <path
        d="M12 2.8l2.6 1.9 3.2-.2.9 3.1 2.5 2-1.7 2.7.5 3.2-3.1 1.1-1.6 2.8-3.3-.8-3.3.8-1.6-2.8L4 15.5l.5-3.2-1.7-2.7 2.5-2 .9-3.1 3.2.2z"
        fill="currentColor"
      />
      <circle cx="12" cy="10.4" r="2.6" fill="none" stroke="#101418" strokeWidth="1.6" />
    </>
  ),

  [FALLBACK_ICON_ID]: (
    <>
      <circle cx="12" cy="12" r="8.4" {...STROKE} />
      <circle cx="12" cy="12" r="2.1" fill="currentColor" />
    </>
  ),
}

export interface IconProps {
  readonly iconId: string
  readonly className?: string
}

export default function Icon({ iconId, className }: IconProps): ReactElement {
  const resolved = iconId in ICONS ? iconId : FALLBACK_ICON_ID
  return (
    <svg
      className={className === undefined ? 'icon' : `icon ${className}`}
      viewBox="0 0 24 24"
      data-icon={resolved}
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[resolved]}
    </svg>
  )
}
