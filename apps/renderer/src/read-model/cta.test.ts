import { describe, expect, it } from 'vitest'
import { COMMAND_ALIASES } from '@vl/contract'

import { sampleSnapshot } from '../testing/fixtures'
import { FREE_CARE_COMMANDS, commandLabel, selectCta } from './cta'

/**
 * Spec §5.2(3) and TASK_SPECS §T14: the call to action is the three free
 * commands and the free-participation note, and the server decides through
 * `interactionEnabled` whether it is live at all (spec §9.2).
 */

describe('selectCta', () => {
  it('always offers the three free care commands', () => {
    const cta = selectCta(sampleSnapshot())
    expect(cta.commands).toEqual(FREE_CARE_COMMANDS)
    expect(cta.commands).toEqual(['FEED', 'PLAY', 'PET'])
    expect(cta.enabled).toBe(true)
    expect(cta.choice).toBeNull()
  })

  it('adds the open decision without replacing the free commands', () => {
    const snapshot = sampleSnapshot()
    const cta = selectCta({
      ...snapshot,
      mission: {
        missionId: 'sample-mission',
        progress: { current: 0, target: 2 },
        choices: [
          { choiceId: 'sample-a', labelKey: 'sample.a', commandName: 'VOTE_A' },
          // Gate closed: the option exists but carries no vote command (A-1, A-9).
          { choiceId: 'sample-b', labelKey: 'sample.b', commandName: null },
        ],
        choiceClosesAt: '2026-08-17T00:02:00.000Z',
      },
    })

    expect(cta.commands).toEqual(FREE_CARE_COMMANDS)
    expect(cta.choice?.options).toEqual([
      { choiceId: 'sample-a', labelKey: 'sample.a', commandName: 'VOTE_A' },
      { choiceId: 'sample-b', labelKey: 'sample.b', commandName: null },
    ])
    expect(cta.choice?.closesAt).toBe('2026-08-17T00:02:00.000Z')
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
    expect(cta.choice).toBeNull()
  })

  it('is disabled before the first snapshot and whenever the server says so', () => {
    expect(selectCta(null).enabled).toBe(false)
    expect(selectCta(null).choice).toBeNull()
    expect(selectCta(sampleSnapshot({ interactionEnabled: false })).enabled).toBe(false)
  })
})

describe('commandLabel', () => {
  it('takes the wording, the emoji and the short alias from the contract table', () => {
    // The values themselves are §7.1 data in `COMMAND_ALIASES`; this fixes which
    // of them the screen shows, without a second copy of the wording here.
    const feed = commandLabel('FEED')
    expect(feed.ja).toBe(COMMAND_ALIASES.FEED.ja[0])
    expect(feed.emoji).toBe(COMMAND_ALIASES.FEED.icons[0])
    expect(feed.en).toBe('FEED')
    expect(feed.iconId).toBe('icon_command_feed')
  })

  it('invents no wording for the vote letters §7.1 gives none', () => {
    expect(COMMAND_ALIASES.VOTE_A.ja).toEqual([])
    expect(commandLabel('VOTE_A')).toEqual({
      name: 'VOTE_A',
      ja: null,
      emoji: null,
      en: 'A',
      iconId: null,
    })
  })
})
