import { describe, expect, it } from 'vitest'
import { WorldSnapshotSchema } from '@vl/contract'

import { JA_ENTRIES } from '../i18n/index'
import { PREVIEW_STATES, previewState } from './preview-states'

/**
 * The six representative screens of TASK_SPECS §T14 acceptance 1 and the
 * consented-viewer screen of §T20c.
 *
 * Two things are checked here, and both are about honesty rather than looks:
 * nothing in a preview may look like real participation (spec §2.6), and every
 * key a screenshot shows must actually resolve — a screenshot full of raw i18n
 * keys would be evidence of nothing.
 */

const REQUIRED = [
  'calm',
  'hungry',
  'play',
  'sleeping',
  'degraded',
  'paid-thanks',
  'consented-action',
]

describe('preview states', () => {
  it('covers the situations the acceptance criteria name', () => {
    expect(PREVIEW_STATES.map((state) => state.name)).toEqual(REQUIRED)
    for (const name of REQUIRED) expect(previewState(name)).toBeDefined()
    expect(previewState('sample-missing')).toBeUndefined()
  })

  it('is valid contract data', () => {
    for (const state of PREVIEW_STATES) {
      expect(() => WorldSnapshotSchema.parse(state.snapshot)).not.toThrow()
      expect(state.description.length).toBeGreaterThan(10)
    }
  })

  it('labels everything that stands for participation as synthetic', () => {
    for (const state of PREVIEW_STATES) {
      for (const effect of state.effects) {
        expect(effect.effectId.startsWith('sample-'), effect.effectId).toBe(true)
        if (effect.cause.kind === 'event') {
          expect(effect.cause.eventKey.startsWith('simulator:sample-')).toBe(true)
        }
      }
      expect(state.snapshot.creature.creatureId.startsWith('sample-')).toBe(true)
    }
  })

  it('shows the situations it claims to show', () => {
    expect(previewState('sleeping')?.snapshot.display.currentNeedOrMission.textKey).toBe(
      'crisis.sleeping',
    )
    expect(previewState('hungry')?.snapshot.display.currentNeedOrMission.textKey).toBe(
      'need.hungry',
    )
    expect(previewState('degraded')?.snapshot.interactionEnabled).toBe(false)
    expect(previewState('degraded')?.snapshot.broadcastLifecycle).toBe('degraded')
    expect(previewState('play')?.snapshot.display.aggregateWindow?.tallies.length).toBe(3)
    expect(previewState('paid-thanks')?.effects.some((effect) => effect.paid)).toBe(true)
  })

  it('shows a consented viewer only where D-9 allows one', () => {
    const consented = previewState('consented-action')
    const named = consented?.effects.filter(
      (effect) => effect.kind === 'ACTION_REACTION' && (effect.actor ?? null) !== null,
    )
    expect(named).toHaveLength(1)
    // The slot can only draw the name if it can join the two messages, so the
    // preview has to be a state the join actually succeeds on (T20c).
    const action = consented?.snapshot.display.lastAppliedAction
    expect(named?.[0]?.kind === 'ACTION_REACTION' && named[0].payload.commandName).toBe(
      action?.commandName,
    )
    expect(action?.contributionCount).toBe(1)

    // Every other preview stays exactly as anonymous as it was before D-9.
    const elsewhere = PREVIEW_STATES.filter((state) => state.name !== 'consented-action').flatMap(
      (state) => state.effects.filter((effect) => 'actor' in effect && effect.actor != null),
    )
    expect(elsewhere).toEqual([])
  })

  it('uses only wording the resource can resolve, so no screenshot shows a raw key', () => {
    const missing: string[] = []
    const check = (key: string): void => {
      if (JA_ENTRIES[key] === undefined) missing.push(key)
    }

    for (const state of PREVIEW_STATES) {
      const { snapshot } = state
      check(snapshot.display.currentNeedOrMission.textKey)
      check(snapshot.display.growthOrChapterProgress.textKey)
      check(`stage.${snapshot.creature.growthStage}`)
      for (const choice of snapshot.mission?.choices ?? []) check(choice.labelKey)
      for (const effect of state.effects) {
        if (effect.kind === 'MISSION_UPDATE') check(`mission.${effect.payload.missionId}`)
        if (effect.kind === 'PAID_THANKS') check(`ui.thanks.${effect.payload.paidEventKind}`)
      }
    }

    expect(missing).toEqual([])
  })
})
