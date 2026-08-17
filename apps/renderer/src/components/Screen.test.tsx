// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { RendererToServerMessage } from '@vl/contract'

import { createRuntime, type RendererRuntime } from '../runtime'
import {
  FakeClock,
  FakeFrameScheduler,
  FakeTimers,
  createFakeSocketFactory,
  sequenceRandom,
  type FakeSocketFactory,
} from '../testing/fakes'
import { sampleSnapshot } from '../testing/fixtures'
import Screen from './Screen'

/**
 * The DOM layer of the stage: the four fixed slots of spec §5.2 drawn from
 * `snapshot.display` only, the CTA rule of spec §9.2, and the commit that
 * releases the ACK (spec §7.3(7)).
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Harness {
  runtime: RendererRuntime
  scheduler: FakeFrameScheduler
  sockets: FakeSocketFactory
  container: HTMLElement
  root: Root
  sent(): RendererToServerMessage[]
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

  const harness: Harness = {
    runtime,
    scheduler,
    sockets,
    container,
    root,
    sent: () => sockets.last().parsedSent() as RendererToServerMessage[],
  }
  mounted.push(harness)
  return harness
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

describe('Screen (spec §5.2, §9.2, §12.3)', () => {
  it('waits for the server instead of inventing a state', () => {
    const harness = mount()
    expect(query(harness, 'hud-waiting')?.textContent).toBe('接続中')
    expect(query(harness, 'hud')).toBeNull()
  })

  it('draws the four fixed slots from snapshot.display', () => {
    const harness = mount()
    show(harness)

    expect(query(harness, 'slot-need')?.textContent).toContain('いまのおねがい')
    expect(query(harness, 'slot-need')?.textContent).toContain('sample.need_food')
    expect(query(harness, 'slot-last-action')?.textContent).toContain('ごはん')
    expect(query(harness, 'slot-last-action-count')?.textContent).toBe('12回')
    // 2026-08-17T00:00:30Z is 09:00 JST (spec §5.3).
    expect(query(harness, 'slot-last-action')?.textContent).toContain('09:00 JST')
    expect(query(harness, 'slot-progress')?.textContent).toContain('1 / 3')
    expect(query(harness, 'slot-progress-bar')?.querySelector<HTMLElement>('.progress-fill')?.style
      .width).toBe('33.33333333333333%')
    expect(query(harness, 'slot-next-choice')?.textContent).toContain('09:10 JST')
  })

  it('shows the undecided next choice instead of blanking the slot', () => {
    const harness = mount()
    const snapshot = sampleSnapshot()
    show(harness, {
      ...snapshot,
      display: { ...snapshot.display, nextChoiceAt: null, lastAppliedAction: null },
    })

    expect(query(harness, 'slot-next-choice')?.textContent).toContain('未定')
    expect(query(harness, 'slot-last-action')?.textContent).toContain('なし')
  })

  it('offers the free command allowlist when the snapshot names no commands', () => {
    const harness = mount()
    show(harness)

    const cta = query(harness, 'cta')
    expect(cta?.dataset['ctaSource']).toBe('allowlist')
    expect(cta?.textContent).toContain('ごはん')
    expect(cta?.textContent).toContain('あそぶ')
    expect(cta?.textContent).toContain('なでる')
    expect(query(harness, 'interaction-paused')).toBeNull()
  })

  it('offers the open choice commands when a choice window is open', () => {
    const harness = mount()
    const snapshot = sampleSnapshot()
    show(harness, {
      ...snapshot,
      mission: {
        missionId: 'sample-mission',
        progress: { current: 1, target: 4 },
        choices: [
          { choiceId: 'sample-choice-a', labelKey: 'sample.choice_a', commandName: 'VOTE_A' },
          { choiceId: 'sample-choice-b', labelKey: 'sample.choice_b', commandName: 'VOTE_B' },
        ],
        choiceClosesAt: '2026-08-17T00:02:00.000Z',
      },
    })

    const cta = query(harness, 'cta')
    expect(cta?.dataset['ctaSource']).toBe('choices')
    expect(query(harness, 'cta-command-VOTE_A')).not.toBeNull()
    expect(query(harness, 'cta-command-FEED')).toBeNull()
  })

  it('hides the CTA and says 相互作用一時停止 when the server disables interaction', () => {
    const harness = mount()
    show(harness, sampleSnapshot({ interactionEnabled: false }))

    expect(query(harness, 'cta')).toBeNull()
    expect(query(harness, 'interaction-paused')?.textContent).toBe('相互作用一時停止')
    // The four slots stay: only the call to action is withdrawn (spec §9.2).
    expect(query(harness, 'slot-need')).not.toBeNull()
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
