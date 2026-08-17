import {
  CONTRACT_VERSION,
  IngestEnvelopeSchema,
  type CommandParser,
  type IngestEnvelope,
  type PaymentDetails,
} from '@vl/contract'

import { ScenarioError, type ControlName, type Scenario, type ScenarioStep } from './schema.js'

/**
 * Scenario → `IngestEnvelope` sequence.
 *
 * The plan is built once and holds no clock. Each batch is a set of steps that
 * share an offset; the runner stamps the batch with the instant its own clock
 * reports and gets the envelopes for that instant. Keeping the instant out of
 * this module is what lets one scenario file drive both the virtual-clock CI run
 * and the system-clock latency report without either set of `receivedAt` values
 * being invented (spec §7.5, §11 엔진 지연).
 *
 * Everything produced here is labelled `source: "simulator"`, which the ingest
 * endpoint also enforces: synthetic participation is never presented as real
 * (spec §2.6, §T11 acceptance 3).
 */

export interface ScenarioIdentity {
  readonly broadcastId: string
  readonly liveChatId: string
}

/** Obviously synthetic ids derived from the scenario id (spec §2.6). */
export function scenarioIdentity(scenario: Scenario, broadcastSuffix?: string): ScenarioIdentity {
  const slug = scenario.id.replace(/-/g, '_')
  const suffix = broadcastSuffix === undefined ? '' : `_${broadcastSuffix.replace(/-/g, '_')}`
  return { broadcastId: `brd_sim_${slug}${suffix}`, liveChatId: `chat_sim_${slug}` }
}

export interface ScenarioBatch {
  readonly atMs: number
  readonly steps: readonly ScenarioStep[]
  /** Control steps at this offset, in order (spec §9.2 degraded window). */
  readonly controls: readonly ControlName[]
  /** Envelopes for this batch, stamped with the runner's instant. */
  build(receivedAt: string): IngestEnvelope[]
}

export interface ScenarioPlan {
  readonly scenario: Scenario
  readonly identity: ScenarioIdentity
  readonly batches: readonly ScenarioBatch[]
  /** Last offset the runner has to reach, so an idle tail is not cut short. */
  readonly endsAtMs: number
  /** Envelopes this scenario will inject in total (control/wait steps excluded). */
  readonly envelopeCount: number
}

export interface PlanOptions {
  /**
   * T6's command parser. Required by any scenario with a `chat` step: raw text
   * has no envelope field, so only the parser's verdict can cross (spec §7.3(1)).
   */
  readonly parseCommand?: CommandParser
  /**
   * Appended to the derived `broadcastId`, which makes a second playback of the
   * same file a **different synthetic broadcast** rather than a replay of the
   * first. The dev panel uses it so pressing "run" twice injects twice; a replay
   * test leaves it out, because there the redelivery is the point (spec §7.4:
   * the event key is built from the broadcast id).
   */
  readonly broadcastSuffix?: string
}

/** True when the scenario cannot be built without a command parser. */
export function requiresParser(scenario: Scenario): boolean {
  return scenario.steps.some((step) => step.kind === 'chat')
}

export function planScenario(scenario: Scenario, options: PlanOptions = {}): ScenarioPlan {
  const parseCommand = options.parseCommand
  if (requiresParser(scenario) && parseCommand === undefined) {
    throw new ScenarioError(
      `${scenario.id} has chat steps and needs a command parser (spec §7.3(1))`,
    )
  }
  const identity = scenarioIdentity(scenario, options.broadcastSuffix)

  const byOffset = new Map<number, ScenarioStep[]>()
  for (const step of scenario.steps) {
    const bucket = byOffset.get(step.atMs)
    if (bucket === undefined) byOffset.set(step.atMs, [step])
    else bucket.push(step)
  }

  let sequence = 0
  let envelopeCount = 0
  const batches: ScenarioBatch[] = []
  for (const atMs of [...byOffset.keys()].sort((a, b) => a - b)) {
    const steps = byOffset.get(atMs) as ScenarioStep[]
    // Ids are assigned while planning, not while running, so a replay of the
    // same file produces the same `messageId`s and therefore the same dedupe
    // outcome (spec §11 유료 무결성).
    const builders: ((receivedAt: string) => IngestEnvelope)[] = []
    for (const step of steps) {
      for (const template of expandStep(step, scenario, parseCommand)) {
        sequence += 1
        const messageId = template.messageId ?? defaultMessageId(scenario, sequence)
        builders.push((receivedAt) => finalize(template, messageId, receivedAt, identity))
      }
    }
    envelopeCount += builders.length
    batches.push({
      atMs,
      steps,
      controls: steps.flatMap((step) => (step.kind === 'control' ? [step.control] : [])),
      build: (receivedAt) => builders.map((builder) => builder(receivedAt)),
    })
  }

  // A trailing `wait` is part of the run: an idle scenario is nothing but the
  // interval it asks the world to cross (spec §2.1).
  const endsAtMs = scenario.steps.reduce(
    (max, step) => Math.max(max, step.atMs + (step.kind === 'wait' ? step.durationMs : 0)),
    0,
  )
  return { scenario, identity, batches, endsAtMs, envelopeCount }
}

function defaultMessageId(scenario: Scenario, sequence: number): string {
  return `msg_sim_${scenario.id}_${String(sequence).padStart(5, '0')}`
}

/**
 * The envelope minus the two things only the runner knows: the id it was given
 * and the instant it was received.
 */
interface EnvelopeTemplate {
  readonly messageId?: string | undefined
  readonly valid:
    | {
        readonly kind: 'CHAT_COMMAND' | 'SUPER_CHAT' | 'SUPER_STICKER' | 'GIFT' | 'MEMBERSHIP'
        readonly command: { name: string; argument: string | null } | null
        readonly payment: PaymentDetails | null
      }
    | undefined
  readonly rejected:
    | {
        readonly status: 'unsupported' | 'invalid'
        readonly code: string
        readonly field: string | null
        readonly sourceMessageType: string | null
      }
    | undefined
}

const EMPTY_PAYMENT: PaymentDetails = {
  amountMicros: null,
  currency: null,
  tier: null,
  jewels: null,
  comboCount: null,
  giftName: null,
}

function expandStep(
  step: ScenarioStep,
  scenario: Scenario,
  parseCommand: CommandParser | undefined,
): EnvelopeTemplate[] {
  switch (step.kind) {
    case 'wait':
    case 'control':
      return []
    case 'command':
      return repeat(step.count, (index) => ({
        messageId: explicitId(step.messageId, index),
        valid: {
          kind: 'CHAT_COMMAND',
          command: { name: step.command, argument: step.argument },
          payment: null,
        },
        rejected: undefined,
      }))
    case 'chat': {
      // The parser is the only door raw text has. A rejected line still becomes
      // a valid envelope with no command, exactly as the source adapters build
      // it, so the inbox records that the message existed without recording what
      // it said (spec §7.3(1), §12.3).
      const parser = parseCommand as CommandParser
      const command = parser(step.text)
      return repeat(step.count, (index) => ({
        messageId: explicitId(step.messageId, index),
        valid: { kind: 'CHAT_COMMAND', command, payment: null },
        rejected: undefined,
      }))
    }
    case 'superChat':
    case 'superSticker':
      return [
        {
          messageId: step.messageId,
          valid: {
            kind: step.kind === 'superChat' ? 'SUPER_CHAT' : 'SUPER_STICKER',
            command: null,
            payment: {
              ...EMPTY_PAYMENT,
              amountMicros: step.amountMicros,
              currency: step.currency,
              tier: step.tier,
            },
          },
          rejected: undefined,
        },
      ]
    case 'gift':
      return [
        {
          messageId: step.messageId,
          valid: {
            kind: 'GIFT',
            command: null,
            payment: {
              ...EMPTY_PAYMENT,
              jewels: step.jewels,
              comboCount: step.comboCount,
              giftName: step.giftName,
            },
          },
          rejected: undefined,
        },
      ]
    case 'membership':
      return [
        {
          messageId: step.messageId,
          valid: {
            kind: 'MEMBERSHIP',
            command: null,
            payment: { ...EMPTY_PAYMENT, tier: step.tier },
          },
          rejected: undefined,
        },
      ]
    case 'unsupported':
      return [
        {
          messageId: step.messageId,
          valid: undefined,
          rejected: {
            status: 'unsupported',
            code: 'UNSUPPORTED_MESSAGE_TYPE',
            field: 'snippet.type',
            sourceMessageType: step.sourceMessageType,
          },
        },
      ]
    case 'invalid':
      return [
        {
          messageId: step.messageId,
          valid: undefined,
          rejected: {
            status: 'invalid',
            code: step.code,
            field: step.field,
            sourceMessageType: null,
          },
        },
      ]
    default: {
      // Exhaustiveness: a new step kind must be handled, not silently dropped.
      const never: never = step
      throw new ScenarioError(`${scenario.id} has an unhandled step ${JSON.stringify(never)}`)
    }
  }
}

/**
 * An explicit id may only be reused by the first repetition; repeats get their
 * generated id back. A scenario that wants the *same* id twice (the duplicate
 * Super Chat of spec §11) writes two steps with the same `messageId`.
 */
function explicitId(messageId: string | undefined, index: number): string | undefined {
  return index === 0 ? messageId : undefined
}

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index))
}

function finalize(
  template: EnvelopeTemplate,
  messageId: string,
  receivedAt: string,
  identity: ScenarioIdentity,
): IngestEnvelope {
  const shared = {
    schemaVersion: CONTRACT_VERSION,
    sourceShape: 'simulator',
    source: 'simulator',
    broadcastId: identity.broadcastId,
    liveChatId: identity.liveChatId,
    receivedAt,
    messageId,
  }
  const document =
    template.valid === undefined
      ? {
          ...shared,
          validationStatus: (template.rejected as { status: string }).status,
          validationError: {
            code: (template.rejected as { code: string }).code,
            field: (template.rejected as { field: string | null }).field,
            sourceMessageType: (template.rejected as { sourceMessageType: string | null })
              .sourceMessageType,
          },
        }
      : {
          ...shared,
          validationStatus: 'valid',
          kind: template.valid.kind,
          occurredAt: receivedAt,
          command: template.valid.command,
          payment: template.valid.payment,
        }
  const parsed = IngestEnvelopeSchema.safeParse(document)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ScenarioError(
      `step produced an invalid envelope: ${issue === undefined ? 'unknown' : `${issue.path.join('.')}: ${issue.message}`}`,
    )
  }
  return parsed.data
}
