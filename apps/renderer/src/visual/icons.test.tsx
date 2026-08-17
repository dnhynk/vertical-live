// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import Icon from './icons'

/**
 * The icon set of spec §5.1, and the fallback that keeps an identifier the
 * content director added from blanking a fixed slot.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: { root: Root; container: HTMLElement }[] = []

function render(iconId: string): SVGSVGElement {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push({ root, container })
  act(() => {
    root.render(<Icon iconId={iconId} />)
  })
  const svg = container.querySelector('svg')
  if (svg === null) throw new Error('icon did not render')
  return svg
}

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => {
      root.unmount()
    })
    container.remove()
  }
})

/**
 * Every identifier the world can put in the fixed slot or in a paid
 * acknowledgement (T7 `project.ts` builds `icon_need_*` and `icon_crisis_*`,
 * `paid.ts` fixes the `thanks_*` table).
 */
const WORLD_ICON_IDS = [
  'icon_need_hungry',
  'icon_need_play',
  'icon_need_affection',
  'icon_need_rest',
  'icon_crisis_sleeping',
  'icon_crisis_tired',
  'icon_crisis_needs_help',
  'thanks_super_chat',
  'thanks_super_sticker',
  'thanks_gift',
  'thanks_membership',
  'icon_command_feed',
  'icon_command_play',
  'icon_command_pet',
]

describe('Icon', () => {
  it('draws every identifier the world can send', () => {
    for (const iconId of WORLD_ICON_IDS) {
      const svg = render(iconId)
      expect(svg.dataset['icon']).toBe(iconId)
      expect(svg.querySelectorAll('path, circle, rect').length).toBeGreaterThan(0)
    }
  })

  it('draws the neutral fallback for an identifier it does not know', () => {
    const svg = render('sample-icon-from-the-future')
    expect(svg.dataset['icon']).toBe('icon_fallback')
    expect(svg.querySelectorAll('circle').length).toBeGreaterThan(0)
  })

  it('is decorative markup, not text: it can carry no name or chat line', () => {
    const svg = render('icon_need_hungry')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.textContent).toBe('')
  })
})
