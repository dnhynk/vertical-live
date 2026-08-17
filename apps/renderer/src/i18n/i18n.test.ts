import { describe, expect, it } from 'vitest'

import { RendererLog } from '../read-model/log'
import { FakeClock } from '../testing/fakes'
import { JA_ENTRIES, createAlias, createTranslator, formatJstTime } from './index'

/**
 * Resolution rules for the Japanese-first screen (spec §5.3). The wording itself
 * is asserted against `ja.json` rather than repeated here: `japanese-source.test.ts`
 * keeps it the only file in the renderer that carries Japanese.
 */

describe('createTranslator', () => {
  it('resolves a key to the wording in the resource', () => {
    const translate = createTranslator(new RendererLog(new FakeClock()))
    expect(translate('ui.interactionPaused')).toBe(JA_ENTRIES['ui.interactionPaused']?.text)
    expect(translate('ui.slot.needOrMission')).toBe(JA_ENTRIES['ui.slot.needOrMission']?.text)
  })

  it('interpolates counts without accepting free text from the wire', () => {
    const translate = createTranslator(new RendererLog(new FakeClock()))
    const template = JA_ENTRIES['ui.contributions']?.text ?? ''

    expect(translate('ui.contributions', { count: 7 })).toBe(template.replace('{count}', '7'))
    // A parameter the template does not name leaves the template alone: nothing
    // from the wire can be appended to a sentence this way.
    expect(translate('ui.contributions', { other: 'x' })).toBe(template)
  })

  it('renders an unknown key as the key and reports it once', () => {
    const log = new RendererLog(new FakeClock())
    const translate = createTranslator(log)

    expect(translate('sample.need_food')).toBe('sample.need_food')
    expect(translate('sample.need_food')).toBe('sample.need_food')

    const missing = log.entries().filter((entry) => entry.code === 'i18n_missing_key')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.detail).toBe('sample.need_food')
  })
})

describe('createAlias', () => {
  it('returns the short English alias of spec §5.1, or nothing where there is none', () => {
    const alias = createAlias()
    expect(alias('ui.slot.needOrMission')).toBe('NOW')
    expect(alias('need.hungry')).toBe('HUNGRY')
    // A count template has no alias, and neither has a key the resource lacks.
    expect(alias('ui.contributions')).toBeNull()
    expect(alias('sample.unknown_key')).toBeNull()
  })
})

describe('formatJstTime', () => {
  it('formats absolute UTC instants in JST', () => {
    expect(formatJstTime('2026-08-17T00:00:30.000Z')).toBe('09:00')
    expect(formatJstTime('2026-08-16T15:00:00.000Z')).toBe('00:00')
  })
})
