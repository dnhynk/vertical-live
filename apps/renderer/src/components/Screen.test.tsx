// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMAND_ALIASES, type Effect, type RendererToServerMessage } from '@vl/contract'

import { JA_ENTRIES } from '../i18n/index'
import { createRuntime, type RendererRuntime } from '../runtime'
import {
  FakeClock,
  FakeFrameScheduler,
  FakeTimers,
  createFakeSocketFactory,
  sequenceRandom,
  type FakeSocketFactory,
} from '../testing/fakes'
import {
  sampleActionEffect,
  samplePaidThanksEffect,
  sampleSnapshot,
} from '../testing/fixtures'
import Screen from './Screen'

/**
 * The DOM layer of the stage: the four fixed slots of spec §5.2 drawn from
 * `snapshot.display` only, the mode badge of spec §6.4, the free call to action
 * of §5.2(3) with the note of §8.5, the paid acknowledgement of §8.4, the CTA
 * rule of §9.2, and the commit that releases the ACK (spec §7.3(7)).
 *
 * Wording is asserted through `ja.json` so this file stays free of Japanese
 * literals (TASK_SPECS §T14 acceptance 2, checked by `japanese-source.test.ts`).
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function ja(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  let text = JA_ENTRIES[key]?.text ?? key
  for (const [name, value] of Object.entries(params)) {
    text = text.replace(`{${name}}`, String(value))
  }
  return text
}

interface Harness {
  runtime: RendererRuntime
  clock: FakeClock
  scheduler: FakeFrameScheduler
  sockets: FakeSocketFactory
  container: HTMLElement
  root: Root
  sent(): RendererToServerMessage[]
  /** One `requestAnimationFrame` tick, with React allowed to commit after it. */
  frame(): void
  effectAcks(): RendererToServerMessage[]
}

const mounted: Harness[] = []

function mount(search = ''): Harness {
  const clock = new FakeClock()
  const timers = new FakeTimers(clock)
  const scheduler = new FakeFrameScheduler()
  const sockets = createFakeSocketFactory()
  const runtime = createRuntime({
    search,
    clock,
    timers,
    frameScheduler: scheduler,
    socketFactory: sockets.factory,
    random: sequenceRandom([0.5]),
    generateRendererId: () => 'renderer-test',
  })
  runtime.start()
  sockets.last().emitOpen()

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Screen runtime={runtime} />)
  })

  const sent = (): RendererToServerMessage[] =>
    sockets.last().parsedSent() as RendererToServerMessage[]

  const harness: Harness = {
    runtime,
    clock,
    scheduler,
    sockets,
    container,
    root,
    sent,
    frame: () => {
      act(() => {
        scheduler.runFrame()
      })
    },
    effectAcks: () => sent().filter((message) => message.type === 'ack_effect'),
  }
  mounted.push(harness)
  return harness
}

function sendEffect(harness: Harness, effect: Effect): void {
  act(() => {
    harness.sockets.last().emitMessage({
      schemaVersion: 1,
      sentAt: '2026-08-17T00:00:00.000Z',
      type: 'effect',
      effect,
    })
  })
}

function show(harness: Harness, snapshot = sampleSnapshot()): void {
  act(() => {
    harness.sockets.last().emitMessage({
      schemaVersion: 1,
      sentAt: '2026-08-17T00:00:00.000Z',
      type: 'snapshot',
      snapshot,
    })
  })
}

function query(harness: Harness, testId: string): HTMLElement | null {
  return harness.container.querySelector(`[data-testid="${testId}"]`)
}

afterEach(() => {
  for (const harness of mounted.splice(0)) {
    act(() => {
      harness.root.unmount()
    })
    harness.container.remove()
    harness.runtime.stop()
  }
})

describe('Screen (spec §5.2, §6.4, §8.4, §9.2, §12.3)', () => {
  it('waits for the server instead of inventing a state', () => {
    const harness = mount()
    expect(query(harness, 'hud-waiting')?.textContent).toBe(ja('ui.waiting'))
    expect(query(harness, 'hud')).toBeNull()
    expect(query(harness, 'cta')).toBeNull()
  })

  it('draws the four fixed slots from snapshot.display', () => {
    const harness = mount()
    show(harness)

    const need = query(harness, 'slot-need')
    expect(need?.textContent).toContain(ja('ui.slot.needOrMission'))
    expect(need?.textContent).toContain('NOW')
    expect(query(harness, 'slot-need-text')?.textContent).toBe('sample.need_food')

    const action = query(harness, 'slot-last-action')
    expect(action?.textContent).toContain(COMMAND_ALIASES.FEED.ja[0])
    expect(query(harness, 'slot-last-action-count')?.textContent).toBe(
      ja('ui.contributions', { count: 12 }),
    )
    // 2026-08-17T00:00:30Z is 09:00 JST (spec §5.3).
    expect(action?.textContent).toContain('09:00 JST')

    // Growth is a bar, not the `current / target` pair the world keeps: the
    // screen shows no internal value it was not asked for (spec §5.2).
    expect(
      query(harness, 'slot-progress-bar')?.querySelector<HTMLElement>('.progress-fill')?.style.width,
    ).toBe('33.33333333333333%')
    expect(query(harness, 'slot-progress')?.textContent).not.toMatch(/\d/)
    const beats = query(harness, 'slot-progress-beats')?.querySelectorAll('li') ?? []
    expect(beats).toHaveLength(3)
    expect([...beats].filter((beat) => beat.className.includes('beat-played'))).toHaveLength(1)

    expect(query(harness, 'slot-next-choice-remaining')?.textContent).toBe(
      ja('ui.remaining', { duration: ja('ui.duration.minutes', { minutes: 10 }) }),
    )
  })

  it('shows the undecided next choice instead of blanking the slot', () => {
    const harness = mount()
    const snapshot = sampleSnapshot()
    show(harness, {
      ...snapshot,
      display: { ...snapshot.display, nextChoiceAt: null, lastAppliedAction: null },
    })

    expect(query(harness, 'slot-next-choice')?.textContent).toContain(ja('ui.undecided'))
    expect(query(harness, 'slot-last-action')?.textContent).toContain(ja('ui.none'))
  })

  it('offers the three free commands and says participation is free', () => {
    const harness = mount()
    show(harness)

    const cta = query(harness, 'cta')
    expect(query(harness, 'cta-command-FEED')).not.toBeNull()
    expect(query(harness, 'cta-command-PLAY')).not.toBeNull()
    expect(query(harness, 'cta-command-PET')).not.toBeNull()
    expect(cta?.textContent).toContain(COMMAND_ALIASES.FEED.ja[0])
    expect(cta?.textContent).toContain(COMMAND_ALIASES.FEED.icons[0])
    expect(cta?.textContent).toContain('FEED')
    expect(query(harness, 'cta-free-note')?.textContent).toBe(ja('ui.cta.freeNote'))
    expect(query(harness, 'interaction-paused')).toBeNull()
  })

  it('adds the open decision without taking the free commands away', () => {
    const harness = mount()
    const snapshot = sampleSnapshot()
    show(harness, {
      ...snapshot,
      mission: {
        missionId: 'sample-mission',
        progress: { current: 1, target: 4 },
        choices: [
          { choiceId: 'sample-choice-a', labelKey: 'sample.choice_a', commandName: 'VOTE_A' },
          { choiceId: 'sample-choice-b', labelKey: 'sample.choice_b', commandName: null },
        ],
        choiceClosesAt: '2026-08-17T00:02:00.000Z',
      },
    })

    expect(query(harness, 'choice-sample-choice-a')?.textContent).toContain('A')
    expect(query(harness, 'choice-sample-choice-b')).not.toBeNull()
    expect(query(harness, 'cta-command-FEED')).not.toBeNull()
  })

  it('shows the input mode, and the window and tally while one is open', () => {
    const harness = mount()
    show(harness)
    expect(query(harness, 'mode-badge')?.dataset['mode']).toBe('direct')
    expect(query(harness, 'mode-badge')?.textContent).toContain(ja('ui.mode.direct'))
    expect(query(harness, 'mode-tallies')).toBeNull()

    const snapshot = sampleSnapshot()
    show(harness, {
      ...snapshot,
      stateRevision: 2,
      inputMode: 'aggregate',
      display: {
        ...snapshot.display,
        aggregateWindow: {
          mode: 'aggregate',
          endsAt: '2026-08-17T00:00:30.000Z',
          tallies: [
            { commandName: 'PLAY', count: 41 },
            { commandName: 'FEED', count: 12 },
          ],
        },
      },
    })

    expect(query(harness, 'mode-badge')?.dataset['mode']).toBe('aggregate')
    expect(query(harness, 'mode-remaining')?.textContent).toBe(
      ja('ui.remaining', { duration: ja('ui.duration.seconds', { seconds: 30 }) }),
    )
    expect(query(harness, 'tally-PLAY')?.textContent).toBe(ja('ui.contributions', { count: 41 }))
    expect(query(harness, 'tally-FEED')?.textContent).toBe(ja('ui.contributions', { count: 12 }))
  })

  it('hides the CTA and says so when the server disables interaction', () => {
    const harness = mount()
    show(harness, sampleSnapshot({ interactionEnabled: false }))

    expect(query(harness, 'cta')).toBeNull()
    expect(query(harness, 'interaction-paused')?.textContent).toContain(ja('ui.interactionPaused'))
    // The four slots stay: only the call to action is withdrawn (spec §9.2).
    expect(query(harness, 'slot-need')).not.toBeNull()
    expect(query(harness, 'hud')).not.toBeNull()
  })

  it('thanks a paid event with a fixed staging and no name, amount or ranking', () => {
    const harness = mount()
    show(harness)
    sendEffect(harness, samplePaidThanksEffect())

    const thanks = query(harness, 'paid-thanks')
    expect(thanks).not.toBeNull()
    expect(thanks?.dataset['paidKind']).toBe('SUPER_CHAT')
    expect(thanks?.textContent).toContain(ja('ui.thanks.title'))
    expect(thanks?.textContent).toContain(ja('ui.thanks.SUPER_CHAT'))
    // The paid surface repeats that everything is reachable for free (§8.5).
    expect(thanks?.textContent).toContain(ja('ui.cta.freeNote'))
    // Nothing about who paid or how much: the payload carries no such field and
    // the staging shows none (spec §8.5, §12.3).
    expect(thanks?.textContent).not.toContain('2')
    expect(query(harness, 'paid-thanks-later')).toBeNull()
  })

  it('marks the substitute acknowledgement that ran after a degraded window', () => {
    const harness = mount()
    show(harness)
    sendEffect(
      harness,
      samplePaidThanksEffect({
        effectId: 'sample-effect-paid-fallback',
        payload: {
          paidEventKind: 'MEMBERSHIP',
          iconId: 'thanks_membership',
          tier: null,
          fallback: true,
        },
      }),
    )

    const thanks = query(harness, 'paid-thanks')
    expect(thanks?.dataset['paidKind']).toBe('MEMBERSHIP')
    expect(thanks?.dataset['fallback']).toBe('true')
    expect(query(harness, 'paid-thanks-later')?.textContent).toBe(ja('ui.thanks.later'))
    // Member identity is a badge icon, never a name (spec §8.3, §12.3).
    expect(thanks?.querySelector('svg')?.dataset['icon']).toBe('thanks_membership')
  })

  it('varies the scene with the world it is drawing (spec §12.5)', () => {
    const harness = mount()
    const snapshot = sampleSnapshot()
    show(harness, {
      ...snapshot,
      environment: {
        environmentId: 'garden',
        worldPhaseId: 'morning',
        weatherId: 'clear',
        chapterId: 'gathering',
        chapterProgress: { current: 1, target: 3 },
      },
    })
    const morning = query(harness, 'screen')?.dataset['palette']

    show(harness, {
      ...snapshot,
      stateRevision: 2,
      environment: {
        environmentId: 'night_terrace',
        worldPhaseId: 'night',
        weatherId: 'rain',
        chapterId: 'festival_prep',
        chapterProgress: { current: 2, target: 3 },
      },
    })

    expect(morning).toBeDefined()
    expect(query(harness, 'screen')?.dataset['palette']).not.toBe(morning)
  })

  it('acks the revision after React commits it and a frame runs', () => {
    const harness = mount()
    show(harness, sampleSnapshot({ stateRevision: 21 }))

    expect(harness.sent().some((message) => message.type === 'ack_state')).toBe(false)

    act(() => {
      harness.scheduler.runFrame()
    })

    expect(harness.sent()).toContainEqual({
      schemaVersion: 1,
      type: 'ack_state',
      stateRevision: 21,
      appliedAt: '2026-08-17T00:00:00.000Z',
    })
  })

  it('re-acknowledges a resent effect without a further React render', () => {
    // Review round 1, blocker 1: a resend changes nothing on screen, so React
    // never renders and `markCommitted` never runs again. The ACK must still go
    // out on the next real frame (spec §7.3(7)).
    const harness = mount()
    show(harness)

    sendEffect(harness, sampleActionEffect())
    harness.frame()
    expect(harness.effectAcks()).toHaveLength(1)
    expect(query(harness, 'effect-sample-effect-action-1')).not.toBeNull()

    const versionBeforeResend = harness.runtime.model.version
    sendEffect(harness, sampleActionEffect())
    // Nothing changed on screen: no notification, therefore no commit.
    expect(harness.runtime.model.version).toBe(versionBeforeResend)
    expect(harness.container.querySelectorAll('.effect-reaction')).toHaveLength(1)

    harness.frame()
    expect(harness.effectAcks()).toHaveLength(2)
    expect(harness.runtime.model.effectStartCount).toBe(1)
  })

  it('shows a scheduled effect on a committed frame before acknowledging it', () => {
    // Review round 1, blocker 2: the frame that opens the window may activate
    // the projection but must not acknowledge it.
    const harness = mount()
    show(harness)

    sendEffect(
      harness,
      sampleActionEffect({
        effectId: 'sample-effect-future',
        startsAt: '2026-08-17T00:00:03.000Z',
        endsAt: '2026-08-17T00:00:09.000Z',
      }),
    )
    harness.frame()
    expect(query(harness, 'effect-sample-effect-future')).toBeNull()
    expect(harness.effectAcks()).toEqual([])

    harness.clock.advance(3_000)
    harness.frame()
    // Now on screen, and still not acknowledged.
    expect(query(harness, 'effect-sample-effect-future')).not.toBeNull()
    expect(harness.effectAcks()).toEqual([])

    harness.frame()
    expect(harness.effectAcks()).toHaveLength(1)
    expect(harness.effectAcks()[0]).toMatchObject({ effectId: 'sample-effect-future' })
  })

  it('keeps the debug panel out of the broadcast mode', () => {
    const broadcast = mount('?mode=broadcast')
    show(broadcast)
    expect(query(broadcast, 'dev-panel')).toBeNull()

    const dev = mount('?mode=dev')
    show(dev)
    expect(query(dev, 'dev-panel')).not.toBeNull()
    expect(query(dev, 'dev-revision')?.textContent).toContain('1')
  })
})
