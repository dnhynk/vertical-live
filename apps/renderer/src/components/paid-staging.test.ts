// Reads the component sources from disk; the browser build carries no node types.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * TASK_SPECS §T14 acceptance 3, as a static check: the paid staging cannot read
 * or write world state.
 *
 * The point is spec §8.5 — payment buys a fixed thanks and nothing else. The
 * server already enforces it (T7 `paid.ts` cannot even produce world state), and
 * this is the same guarantee on the screen: the component that draws a paid
 * acknowledgement is handed four presentation fields, has no snapshot in scope,
 * imports nothing from `read-model/`, and has no handler with which it could
 * send anything back.
 *
 * It also checks what the acknowledgement may not show: no name (spec §12.3),
 * no amount, no tier, no ranking of who paid (spec §8.5).
 */

const COMPONENTS = dirname(fileURLToPath(import.meta.url))

function source(file: string): string {
  // Comments are stripped: prose explaining why a field is absent is not a use
  // of that field.
  return readFileSync(join(COMPONENTS, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

const PAID_THANKS = source('PaidThanks.tsx')
const EFFECT_LAYER = source('EffectLayer.tsx')

/** Anything that would be world state, or a way to reach it. */
const STATE_ACCESS: readonly [string, RegExp][] = [
  ['snapshot', /snapshot/i],
  ['read model', /ReadModel|useReadModel|read-model/],
  ['runtime', /runtime/i],
  ['creature', /creature/i],
  ['mission', /mission/i],
  ['need', /\bneed[A-Z]?/i],
  ['progress', /progress/i],
  ['growth or bond', /growth|bond/i],
  ['state revision', /stateRevision|revision/i],
  ['input mode or window', /inputMode|aggregateWindow|interactionEnabled/i],
  ['tally', /tally|tallies/i],
  ['store or dispatch', /store|dispatch|setState|useState|useReducer/i],
]

/** What spec §8.5 and §12.3 forbid on screen. */
const FORBIDDEN_DISPLAY: readonly [string, RegExp][] = [
  ['a name', /author|displayName|channelId|userName|nickName|supporterName/i],
  ['an amount', /amountMicros|amount|currency|price|jewels|yen/i],
  ['a tier', /tier/i],
  ['a ranking', /rank|leaderboard|top\s*supporter|total(Spent|Paid)/i],
]

describe('PaidThanks.tsx (spec §8.4, §8.5)', () => {
  it('was found and is not empty', () => {
    expect(PAID_THANKS.length).toBeGreaterThan(200)
  })

  it('reads no world state and holds no state of its own', () => {
    const found = STATE_ACCESS.filter(([, pattern]) => pattern.test(PAID_THANKS)).map(
      ([label]) => label,
    )
    expect(found).toEqual([])
  })

  it('shows no name, no amount, no tier and no ranking', () => {
    const found = FORBIDDEN_DISPLAY.filter(([, pattern]) => pattern.test(PAID_THANKS)).map(
      ([label]) => label,
    )
    expect(found).toEqual([])
  })

  it('imports only text and icons, so it has no path to the world', () => {
    const imports = [...PAID_THANKS.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort()
    expect(imports).toEqual(['../i18n/index', '../visual/icons', '@vl/contract'])
  })

  it('has no event handler with which it could send anything back', () => {
    expect(/\son[A-Z][A-Za-z]*=/.test(PAID_THANKS)).toBe(false)
    expect(/addEventListener|fetch\(|WebSocket/.test(PAID_THANKS)).toBe(false)
  })
})

describe('EffectLayer.tsx (the only caller of the paid staging)', () => {
  it('hands the paid staging effect payload fields and nothing else', () => {
    const call = /<PaidThanks([\s\S]*?)\/>/.exec(EFFECT_LAYER)
    expect(call).not.toBeNull()
    const props = [...(call?.[1] ?? '').matchAll(/(\w+)=\{/g)].map((match) => match[1]).sort()
    expect(props).toEqual(['alias', 'fallback', 'iconId', 'paidEventKind', 'translate'])
  })

  it('takes effects and text functions, never a snapshot', () => {
    expect(/snapshot|WorldSnapshot|useReadModel|runtime/i.test(EFFECT_LAYER)).toBe(false)
  })
})
