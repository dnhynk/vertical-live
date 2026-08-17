import {
  parseScenario,
  type Scenario,
  type ScenarioInput,
  type ScenarioStepInput,
} from './schema.js'

/**
 * The built-in scenarios of TASK_SPECS §T11.
 *
 * They are TypeScript data rather than files on disk so that both the CLI and
 * the renderer's `?mode=dev` panel run **the same definitions** — the panel is a
 * browser bundle and cannot read the repository. External scenario files are
 * still supported: the CLI validates them with the same `parseScenario`.
 *
 * The adversarial scenario is *not* here. It is built from T6's rejected/
 * accepted vectors (`runner/adversarial.ts`), which live in `@vl/server`, and it
 * needs the real command parser to become envelopes at all (spec §7.3(1)).
 *
 * Numbers below are read from `config/default.json` (`input.window`,
 * `engine.degraded`), which are provisional (BOARD A-3, A-15). The scenarios are
 * written in terms of *behaviour* — "enough commands in one window to trip the
 * switch" — and the replay tests assert against the loaded config rather than
 * against a literal, so a config change does not silently invalidate them.
 */

/** `input.window.windowMs` in `config/default.json`. */
const WINDOW_MS = 5_000
/** `input.window.enterAggregateAtCommands`. */
const ENTER_AGGREGATE_AT = 30
/** `input.window.maxDirectPerWindow`. */
const MAX_DIRECT_PER_WINDOW = 20

const HOUR_MS = 60 * 60 * 1000

const idle24h: ScenarioInput = {
  id: 'idle-24h',
  title: 'Idle 24h',
  summary:
    'No input at all for 24 virtual hours. Spec §2.1: content, state and narrative advance with zero viewers.',
  requiresVirtualClock: true,
  steps: [{ kind: 'wait', atMs: 0, durationMs: 24 * HOUR_MS }],
}

const directLow: ScenarioInput = {
  id: 'direct-low',
  title: 'Low participation (direct)',
  summary:
    'A handful of free commands spread over several windows: every one is applied individually (spec §6.4 direct mode).',
  steps: [
    { kind: 'command', atMs: 0, command: 'FEED' },
    { kind: 'command', atMs: 1_200, command: 'PET' },
    { kind: 'command', atMs: 2_500, command: 'PLAY' },
    { kind: 'wait', atMs: 2_500, durationMs: WINDOW_MS },
    { kind: 'command', atMs: 8_000, command: 'FEED', count: 3 },
    { kind: 'unsupported', atMs: 8_500, sourceMessageType: 'sponsorOnlyModeStartedEvent' },
    { kind: 'invalid', atMs: 8_600, code: 'MISSING_PUBLISHED_AT', field: 'snippet.published_at' },
    { kind: 'wait', atMs: 9_000, durationMs: 2 * WINDOW_MS },
  ],
}

const aggregateSwitch: ScenarioInput = {
  id: 'aggregate-switch',
  title: 'Direct → aggregate → direct',
  summary:
    'A burst above the switching threshold moves the next window to aggregate; a quiet window brings it back (spec §6.4).',
  steps: [
    // One window with enough commands to trip the switch. The first
    // `maxDirectPerWindow` are applied individually and the rest are tallied —
    // contributions are preserved either way (spec §6.4).
    { kind: 'command', atMs: 100, command: 'FEED', count: ENTER_AGGREGATE_AT + 5 },
    { kind: 'wait', atMs: 100, durationMs: WINDOW_MS },
    // Aggregate window: nothing is applied individually.
    { kind: 'command', atMs: WINDOW_MS + 500, command: 'PLAY', count: 12 },
    { kind: 'wait', atMs: WINDOW_MS + 500, durationMs: WINDOW_MS },
    // Quiet window: back to direct.
    { kind: 'command', atMs: 2 * WINDOW_MS + 500, command: 'PET', count: 2 },
    { kind: 'wait', atMs: 2 * WINDOW_MS + 500, durationMs: 3 * WINDOW_MS },
  ],
}

const flood: ScenarioInput = {
  id: 'flood',
  title: 'Command flood',
  summary:
    'One burst far above the window cap. The screen is protected by aggregation while every contribution is still counted (spec §7.3 마지막 문단).',
  steps: [
    { kind: 'command', atMs: 0, command: 'FEED', count: 20 * MAX_DIRECT_PER_WINDOW },
    { kind: 'command', atMs: 50, command: 'PET', count: 10 * MAX_DIRECT_PER_WINDOW },
    { kind: 'wait', atMs: 50, durationMs: 3 * WINDOW_MS },
  ],
}

const paidReplay: ScenarioInput = {
  id: 'paid-replay',
  title: 'Paid replay',
  summary:
    'A repeated Super Chat, a gift combo that only advances, a Super Sticker and two memberships (spec §11 유료 무결성).',
  steps: [
    {
      kind: 'superChat',
      atMs: 0,
      amountMicros: 500_000,
      currency: 'JPY',
      tier: 1,
      messageId: 'msg_sim_paid_sc_a',
    },
    // The same delivery replayed: one Super Chat, applied once.
    {
      kind: 'superChat',
      atMs: 800,
      amountMicros: 500_000,
      currency: 'JPY',
      tier: 1,
      messageId: 'msg_sim_paid_sc_a',
    },
    {
      kind: 'superSticker',
      atMs: 1_200,
      amountMicros: 200_000,
      currency: 'JPY',
      tier: 1,
      messageId: 'msg_sim_paid_st_a',
    },
    // Non-combo gift: comboCount 0 still counts as the first one (spec §7.4).
    {
      kind: 'gift',
      atMs: 2_000,
      comboCount: 0,
      jewels: 10,
      giftName: 'sim_gift',
      messageId: 'msg_sim_paid_gift_a',
    },
    {
      kind: 'gift',
      atMs: 2_400,
      comboCount: 3,
      jewels: 10,
      giftName: 'sim_gift',
      messageId: 'msg_sim_paid_gift_a',
    },
    // Same combo step twice: the second adds nothing.
    {
      kind: 'gift',
      atMs: 2_800,
      comboCount: 3,
      jewels: 10,
      giftName: 'sim_gift',
      messageId: 'msg_sim_paid_gift_a',
    },
    {
      kind: 'gift',
      atMs: 3_200,
      comboCount: 5,
      jewels: 10,
      giftName: 'sim_gift',
      messageId: 'msg_sim_paid_gift_a',
    },
    // A combo count that went backwards: `storedMax` never decreases.
    {
      kind: 'gift',
      atMs: 3_600,
      comboCount: 2,
      jewels: 10,
      giftName: 'sim_gift',
      messageId: 'msg_sim_paid_gift_a',
    },
    { kind: 'membership', atMs: 4_000, tier: 1, messageId: 'msg_sim_paid_mem_a' },
    { kind: 'membership', atMs: 4_400, tier: 2, messageId: 'msg_sim_paid_mem_b' },
    { kind: 'membership', atMs: 4_800, tier: 2, messageId: 'msg_sim_paid_mem_b' },
    { kind: 'wait', atMs: 4_800, durationMs: 2 * WINDOW_MS },
  ],
}

const degradedWindow: ScenarioInput = {
  id: 'degraded-window',
  title: 'Degraded window',
  summary:
    'Events injected while the broadcast is degraded are kept in the inbox, not shown as accepted, and applied in ingestSeq order after recovery (spec §9.2).',
  requiresVirtualClock: true,
  steps: [
    { kind: 'command', atMs: 0, command: 'FEED' },
    { kind: 'control', atMs: 1_000, control: 'degrade' },
    { kind: 'command', atMs: 2_000, command: 'PET' },
    { kind: 'command', atMs: 2_500, command: 'PLAY' },
    {
      kind: 'superChat',
      atMs: 3_000,
      amountMicros: 300_000,
      currency: 'JPY',
      tier: 1,
      messageId: 'msg_sim_degraded_sc',
    },
    // Well inside `engine.degraded.eventValidityMs`, so the commands are still
    // applicable when the condition clears (spec §9.2 유효시간).
    { kind: 'wait', atMs: 3_000, durationMs: 22_000 },
    { kind: 'control', atMs: 25_000, control: 'recover' },
    { kind: 'wait', atMs: 25_000, durationMs: 2 * WINDOW_MS },
  ],
}

const DOCUMENTS: readonly ScenarioInput[] = [
  idle24h,
  directLow,
  aggregateSwitch,
  flood,
  paidReplay,
  degradedWindow,
]

/**
 * Built-in scenarios that need nothing but `@vl/contract`, so the dev panel can
 * run them in a browser.
 */
export const BUILTIN_SCENARIOS: readonly Scenario[] = DOCUMENTS.map(parseScenario)

export function findBuiltinScenario(id: string): Scenario | null {
  return BUILTIN_SCENARIOS.find((scenario) => scenario.id === id) ?? null
}

/** Re-exported for callers assembling scenarios programmatically. */
export type { ScenarioInput, ScenarioStepInput }
