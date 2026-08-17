import {
  ACCEPTED_VECTORS,
  REJECTED_VECTORS,
  createCommandParserPort,
  loadInputConfig,
  parserLimits,
  type InputConfig,
} from '@vl/server/input'
import type { CommandParser } from '@vl/contract'

import { parseScenario, type Scenario, type ScenarioStepInput } from '../scenario/index.js'

/**
 * The 악성 시나리오 of TASK_SPECS §T11: malicious Unicode, links, contact data,
 * banned terms and command floods replayed through the real parser.
 *
 * It is assembled from **T6's own vectors** rather than a second corpus. The
 * §11 pass line is "모더레이션 우회 0", and a bypass only means something if the
 * simulator is replaying exactly the rule the broadcast path applies — a private
 * list here could pass while the product's list failed.
 *
 * This scenario is not in the browser-safe catalog: raw text becomes an envelope
 * only through the parser (spec §7.3(1)), and the parser is a server module.
 */

/**
 * The parse context the simulator uses. The identity gate is closed (BOARD A-1),
 * so `VOTE_*` is refused; a scenario that wants the open-gate behaviour passes
 * its own context.
 */
export const SIMULATOR_PARSE_CONTEXT = { identityGateOpen: false, voteWindowOpen: false }

export interface CommandParserOptions {
  readonly inputConfig?: InputConfig
  readonly identityGateOpen?: boolean
  readonly voteWindowOpen?: boolean
}

/** T6's parser, wired to the contract's `CommandParser` port. */
export function simulatorCommandParser(options: CommandParserOptions = {}): CommandParser {
  const config = options.inputConfig ?? loadInputConfig({ env: {} })
  return createCommandParserPort({
    context: () => ({
      identityGateOpen: options.identityGateOpen ?? SIMULATOR_PARSE_CONTEXT.identityGateOpen,
      voteWindowOpen: options.voteWindowOpen ?? SIMULATOR_PARSE_CONTEXT.voteWindowOpen,
    }),
    limits: parserLimits(config),
  })
}

/** Free commands per window that push the arbiter into aggregate mode. */
const FLOOD_COUNT = 60

export const ADVERSARIAL_SCENARIO_ID = 'adversarial'

/**
 * Builds the scenario. Every rejected vector is injected once, every accepted
 * vector is injected once, and the two are interleaved so that a filter which
 * simply refused everything would fail the accepted half.
 */
export function buildAdversarialScenario(): Scenario {
  const steps: ScenarioStepInput[] = []
  let atMs = 0

  for (const [index, vector] of REJECTED_VECTORS.entries()) {
    steps.push({ kind: 'chat', atMs, text: vector.text })
    const accepted = ACCEPTED_VECTORS[index % ACCEPTED_VECTORS.length]
    if (accepted !== undefined) {
      steps.push({ kind: 'chat', atMs: atMs + 10, text: accepted.text })
    }
    atMs += 50
  }

  // A command flood made of the *accepted* vectors: the aggregate path must
  // absorb it without any of the rejected text having reached the world.
  const floodAt = atMs + 100
  for (const [index, vector] of ACCEPTED_VECTORS.entries()) {
    steps.push({
      kind: 'chat',
      atMs: floodAt,
      text: vector.text,
      count: Math.ceil(FLOOD_COUNT / ACCEPTED_VECTORS.length) + (index === 0 ? 1 : 0),
    })
  }
  steps.push({ kind: 'wait', atMs: floodAt, durationMs: 15_000 })

  return parseScenario({
    id: ADVERSARIAL_SCENARIO_ID,
    title: 'Adversarial input',
    summary:
      "T6's rejected and accepted parser vectors replayed through POST /ingest/simulator: no malicious message may reach state or screen, and no ordinary message may be lost (spec §11 모더레이션, §12.3).",
    steps,
  })
}
