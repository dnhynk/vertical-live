// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMMAND_ALIASES,
  CONSENT_COMMAND_ALIASES,
  type Effect,
  type RendererToServerMessage,
  type WorldSnapshot,
} from '@vl/contract'

import { JA_ENTRIES } from '../i18n/index'
import { CONSENT_RETENTION_DAYS } from '../read-model/identity'
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
  SAMPLE_CONSENTED_ACTOR,
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

/** The same, for the short English alias a slot shows after the Japanese. */
function en(key: string, params: Readonly<Record<string, string | number>> = {}): string {
  let text = JA_ENTRIES[key]?.en ?? ''
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

/**
 * A snapshot and a reaction the identity join can actually connect (T20c): one
 * viewer's single command, staged at the instant the snapshot says it was
 * applied. The clock starts at that instant, so the reaction is playing.
 */
const NAMED_ACTION_AT = '2026-08-17T00:00:00.000Z'

function consentedSnapshot(): WorldSnapshot {
  const base = sampleSnapshot()
  return sampleSnapshot({
    display: {
      ...base.display,
      lastAppliedAction: { commandName: 'FEED', appliedAt: NAMED_ACTION_AT, contributionCount: 1 },
    },
  })
}

/**
 * The next viewer's identical command, one second later and one commit on: the
 * shape the review's counterexample needs (round 1, blocker 1).
 */
const NEXT_ACTION_AT = '2026-08-17T00:00:01.000Z'

function nextActionSnapshot(): WorldSnapshot {
  const base = sampleSnapshot()
  return sampleSnapshot({
    stateRevision: 2,
    display: {
      ...base.display,
      lastAppliedAction: { commandName: 'FEED', appliedAt: NEXT_ACTION_AT, contributionCount: 1 },
    },
  })
}

function reaction(overrides: Record<string, unknown> = {}): Effect {
  return sampleActionEffect({
    startsAt: NAMED_ACTION_AT,
    endsAt: '2026-08-17T00:00:05.000Z',
    payload: { commandName: 'FEED', contributionCount: 1 },
    ...overrides,
  })
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
      query(harness, 'slot-progress-bar')?.querySelector<HTMLElement>('.progress-fill')?.style
        .width,
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

  it('names the consented viewer whose action the slot is showing (BOARD D-9)', () => {
    const harness = mount()
    show(harness, consentedSnapshot())
    sendEffect(harness, reaction({ actor: SAMPLE_CONSENTED_ACTOR }))

    const name = query(harness, 'slot-last-action-actor')
    expect(name?.textContent).toBe(SAMPLE_CONSENTED_ACTOR.displayName)
    // A text node and nothing else: no markup was parsed to put it there
    // (spec §12.3).
    expect(name?.children).toHaveLength(0)
    expect(name?.firstChild?.nodeType).toBe(Node.TEXT_NODE)
    // The slot still says what happened; the name is an addition, not a
    // replacement (spec §5.2(2)).
    expect(query(harness, 'slot-last-action')?.textContent).toContain(
      ja('ui.contributions', { count: 1 }),
    )
  })

  it('does not lend a name to the next action whose snapshot arrives first (BOARD D-9)', () => {
    // Review round 1, blocker 1, on the screen itself. Viewer A opted in and fed
    // the creature; their reaction plays for four seconds. A second later
    // somebody else feeds, and the server publishes that snapshot **before** its
    // effect (`apps/server/src/engine/engine.ts`), so for a moment the slot
    // describes the new action while only A's named reaction is on screen —
    // same command, same count, staged before the new action was applied. No
    // frame is run in this test, so nothing is acknowledged either: the join may
    // not depend on an ACK having gone out.
    const harness = mount()
    show(harness, consentedSnapshot())
    sendEffect(harness, reaction({ actor: SAMPLE_CONSENTED_ACTOR }))
    expect(query(harness, 'slot-last-action-actor')?.textContent).toBe(
      SAMPLE_CONSENTED_ACTOR.displayName,
    )

    harness.clock.advance(1_000)
    show(harness, nextActionSnapshot())
    expect(query(harness, 'slot-last-action-actor')).toBeNull()
    expect(harness.container.textContent).not.toContain(SAMPLE_CONSENTED_ACTOR.displayName)

    // The new viewer's own reaction arrives. They never opted in, so the slot
    // stays anonymous while A's named effect is still playing.
    sendEffect(
      harness,
      reaction({
        effectId: 'sample-effect-action-b',
        stateRevision: 2,
        startsAt: NEXT_ACTION_AT,
        endsAt: '2026-08-17T00:00:06.000Z',
      }),
    )
    expect(query(harness, 'slot-last-action-actor')).toBeNull()
    expect(harness.container.textContent).not.toContain(SAMPLE_CONSENTED_ACTOR.displayName)

    // And a retransmit of A's reaction (spec §7.3(7)) puts no name back either.
    sendEffect(harness, reaction({ actor: SAMPLE_CONSENTED_ACTOR }))
    expect(query(harness, 'slot-last-action-actor')).toBeNull()
    expect(harness.container.textContent).not.toContain(SAMPLE_CONSENTED_ACTOR.displayName)
  })

  it('names the next consented viewer once their own commit is on screen', () => {
    // The other half of the rule: refusing A's name must not cost B theirs.
    const harness = mount()
    show(harness, consentedSnapshot())
    sendEffect(harness, reaction({ actor: SAMPLE_CONSENTED_ACTOR }))

    harness.clock.advance(1_000)
    show(harness, nextActionSnapshot())
    sendEffect(
      harness,
      reaction({
        effectId: 'sample-effect-action-b',
        stateRevision: 2,
        startsAt: NEXT_ACTION_AT,
        endsAt: '2026-08-17T00:00:06.000Z',
        actor: { ...SAMPLE_CONSENTED_ACTOR, displayName: 'sample-viewer-2' },
      }),
    )
    expect(query(harness, 'slot-last-action-actor')?.textContent).toBe('sample-viewer-2')
    expect(harness.container.textContent).not.toContain(SAMPLE_CONSENTED_ACTOR.displayName)
  })

  it('renders no name at all on a closed-gate screen', () => {
    // Exactly the wire shape of BOARD A-1: `actor` absent from every effect.
    const harness = mount()
    show(harness, consentedSnapshot())
    sendEffect(harness, reaction())
    sendEffect(harness, samplePaidThanksEffect())

    expect(query(harness, 'slot-last-action-actor')).toBeNull()
    expect(harness.container.textContent).not.toContain(SAMPLE_CONSENTED_ACTOR.displayName)
    expect(harness.container.textContent).not.toContain(SAMPLE_CONSENTED_ACTOR.channelRef)
  })

  it('keeps the name off the paid staging and off the reaction chip (spec §8.4)', () => {
    const harness = mount()
    show(harness, consentedSnapshot())
    sendEffect(harness, reaction({ actor: SAMPLE_CONSENTED_ACTOR }))
    sendEffect(harness, samplePaidThanksEffect())

    expect(query(harness, 'paid-thanks')?.textContent).not.toContain(
      SAMPLE_CONSENTED_ACTOR.displayName,
    )
    expect(query(harness, 'effect-sample-effect-action-1')?.textContent).not.toContain(
      SAMPLE_CONSENTED_ACTOR.displayName,
    )
    // The opaque consent reference never reaches the DOM either (T20a).
    expect(harness.container.textContent).not.toContain(SAMPLE_CONSENTED_ACTOR.channelRef)
  })

  /**
   * The public broadcast of 2026-08-29 carried this notice while
   * `identityGateOpen` was false, so every `なのる` a viewer sent came back
   * `consent_disabled`. The screen may only ask for commands the server takes.
   */
  it('says nothing about names while the server is refusing the consent commands', () => {
    const harness = mount()
    show(harness, { ...sampleSnapshot(), identityGateOpen: false })

    expect(query(harness, 'cta-identity')).toBeNull()
    expect(query(harness, 'cta-identity-notice')).toBeNull()
    expect(query(harness, 'cta-consent-command-JOIN')).toBeNull()
    expect(query(harness, 'cta-consent-command-LEAVE')).toBeNull()
    // The free commands it does accept are still there.
    expect(query(harness, 'cta-command-FEED')).not.toBeNull()
  })

  it('says nothing about names when the snapshot does not carry the gate at all', () => {
    const harness = mount()
    // A snapshot from a build that predates the field: absent, not false.
    const withoutGate = sampleSnapshot()
    expect(withoutGate).not.toHaveProperty('identityGateOpen')
    show(harness, withoutGate)

    expect(query(harness, 'cta-identity')).toBeNull()
  })

  it('states how a name gets on screen and how it comes off, next to the CTA', () => {
    const harness = mount()
    // Only while the server is accepting those commands (BOARD D-9, T55).
    show(harness, { ...sampleSnapshot(), identityGateOpen: true })

    const notice = query(harness, 'cta-identity-notice')
    expect(notice?.textContent).toBe(
      ja('ui.identity.notice', {
        join: CONSENT_COMMAND_ALIASES.JOIN.ja[0] ?? '',
        leave: CONSENT_COMMAND_ALIASES.LEAVE.ja[0] ?? '',
        days: CONSENT_RETENTION_DAYS,
      }),
    )
    // The two commands are shown in the spellings the parser accepts (spec §7.1).
    expect(query(harness, 'cta-consent-command-JOIN')?.textContent).toContain(
      CONSENT_COMMAND_ALIASES.JOIN.ja[0],
    )
    expect(query(harness, 'cta-consent-command-LEAVE')?.textContent).toContain(
      CONSENT_COMMAND_ALIASES.LEAVE.ja[0],
    )
    expect(query(harness, 'cta-consent-command-JOIN')?.textContent).toContain(
      ja('ui.identity.join'),
    )
    expect(query(harness, 'cta-consent-command-LEAVE')?.textContent).toContain(
      ja('ui.identity.leave'),
    )

    // The English line is not a shorter notice (review round 1, major 1): it
    // says the same three things, so a viewer who reads only English is told how
    // to take the name off again and when it goes by itself
    // (`docs/ops/identity-consent.md` §2.1 plus D-9's 30 days).
    const english = query(harness, 'cta-identity-notice-en')?.textContent
    expect(english).toBe(
      en('ui.identity.notice', {
        join: CONSENT_COMMAND_ALIASES.JOIN.en[0] ?? '',
        leave: CONSENT_COMMAND_ALIASES.LEAVE.en[0] ?? '',
        days: CONSENT_RETENTION_DAYS,
      }),
    )
    expect(english).toContain(CONSENT_COMMAND_ALIASES.LEAVE.en[0])
    expect(english).toContain('DELETE')
    expect(english).toContain(String(CONSENT_RETENTION_DAYS))
  })

  it('withdraws the consent notice together with the CTA (TASK_SPECS §T14, §T20c)', () => {
    const harness = mount()
    show(harness, sampleSnapshot({ interactionEnabled: false }))

    expect(query(harness, 'cta-identity')).toBeNull()
    expect(query(harness, 'cta-identity-notice')).toBeNull()
    expect(query(harness, 'cta-consent-command-JOIN')).toBeNull()
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
