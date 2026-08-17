import { describe, expect, it } from 'vitest'

import { sampleSnapshot } from '../testing/fixtures'
import { FREE_CARE_COMMANDS, commandLabel, selectCta } from './cta'

/**
 * Spec §5.2(3) with the coordinator's answer of 2026-08-17 (ticket "Questions
 * asked", option A): prefer what the snapshot offers, fall back to the §7.1
 * allowlist, and let the server decide whether the CTA is live at all (§9.2).
 */

describe('selectCta', () => {
  it('shows the free-command allowlist when the snapshot names no command', () => {
    const cta = selectCta(sampleSnapshot())
    expect(cta.source).toBe('allowlist')
    expect(cta.commands).toEqual(FREE_CARE_COMMANDS)
    expect(cta.enabled).toBe(true)
  })

  it('prefers the commands of an open choice window', () => {
    const snapshot = sampleSnapshot()
    const cta = selectCta({
      ...snapshot,
      mission: {
        missionId: 'sample-mission',
        progress: { current: 0, target: 2 },
        choices: [
          { choiceId: 'sample-a', labelKey: 'sample.a', commandName: 'VOTE_A' },
          { choiceId: 'sample-b', labelKey: 'sample.b', commandName: null },
        ],
        choiceClosesAt: '2026-08-17T00:02:00.000Z',
      },
    })
    expect(cta.source).toBe('choices')
    expect(cta.commands).toEqual(['VOTE_A'])
  })

  it('ignores choices while the window is closed', () => {
    const snapshot = sampleSnapshot()
    const cta = selectCta({
      ...snapshot,
      mission: {
        missionId: 'sample-mission',
        progress: { current: 0, target: 2 },
        choices: [{ choiceId: 'sample-a', labelKey: 'sample.a', commandName: 'VOTE_A' }],
        choiceClosesAt: null,
      },
    })
    expect(cta.source).toBe('allowlist')
  })

  it('uses the tallied commands while an aggregate window is open', () => {
    const snapshot = sampleSnapshot()
    const cta = selectCta({
      ...snapshot,
      display: {
        ...snapshot.display,
        aggregateWindow: {
          mode: 'aggregate',
          endsAt: '2026-08-17T00:01:00.000Z',
          tallies: [{ commandName: 'PLAY', count: 41 }],
        },
      },
    })
    expect(cta.source).toBe('aggregate')
    expect(cta.commands).toEqual(['PLAY'])
  })

  it('is disabled before the first snapshot and whenever the server says so', () => {
    expect(selectCta(null).enabled).toBe(false)
    expect(selectCta(sampleSnapshot({ interactionEnabled: false })).enabled).toBe(false)
  })
})

describe('commandLabel', () => {
  it('takes the Japanese wording and icon from the contract alias table', () => {
    expect(commandLabel('FEED')).toEqual({ icon: '🍙', label: 'ごはん' })
    // §7.1 gives the vote commands no Japanese wording and no icon; none is
    // invented here (contract COMMAND_ALIASES).
    expect(commandLabel('VOTE_A')).toEqual({ icon: null, label: 'A' })
  })
})
