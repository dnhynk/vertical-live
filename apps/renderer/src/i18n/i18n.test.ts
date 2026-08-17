import { describe, expect, it } from 'vitest'

import { RendererLog } from '../read-model/log'
import { FakeClock } from '../testing/fakes'
import { JA_NATIVE_REVIEW, createTranslator, formatJstTime } from './index'

describe('ja translation (spec §5.3, BOARD A-11)', () => {
  it('is marked as awaiting native review', () => {
    expect(JA_NATIVE_REVIEW).toBe('pending')
  })

  it('resolves the fixed screen wording', () => {
    const log = new RendererLog(new FakeClock())
    const translate = createTranslator(log)
    expect(translate('ui.interactionPaused')).toBe('相互作用一時停止')
    expect(translate('ui.slot.needOrMission')).toBe('いまのおねがい')
  })

  it('interpolates counts without accepting free text from the wire', () => {
    const translate = createTranslator(new RendererLog(new FakeClock()))
    expect(translate('ui.contributions', { count: 7 })).toBe('7回')
    expect(translate('ui.progressValue', { current: 1, target: 3 })).toBe('1 / 3')
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

  it('formats absolute UTC instants in JST', () => {
    expect(formatJstTime('2026-08-17T00:00:30.000Z')).toBe('09:00')
    expect(formatJstTime('2026-08-16T15:00:00.000Z')).toBe('00:00')
  })
})
