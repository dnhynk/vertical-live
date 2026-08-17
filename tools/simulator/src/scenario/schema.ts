import { CommandNameSchema, ValidationErrorCodeSchema } from '@vl/contract'
import { z } from 'zod'

/**
 * Scenario files (TASK_SPECS §T11): a declarative sequence of synthetic inputs
 * that the runner turns into `IngestEnvelope`s and posts to
 * `POST /ingest/simulator` — the same contract the public broadcast path uses
 * (spec §15 Gate 1 "공개 방송과 같은 이벤트 계약을 쓰는 local simulator").
 *
 * Three properties are enforced by the schema rather than by convention:
 *
 * 1. **Offsets, not instants.** A step says *when* it happens relative to the
 *    start of the run (`atMs`). The absolute `receivedAt` is stamped by the
 *    runner's clock, so the same file replays under a virtual clock (CI) and a
 *    system clock (latency report) without either one being fabricated.
 * 2. **Raw text stays a step input, never an envelope field.** A `chat` step
 *    carries the message a viewer would type; only the *result* of the command
 *    parser reaches the envelope (spec §7.3(1)). The parser is injected, so this
 *    module has no way to smuggle text past it.
 * 3. **Ids are obviously synthetic.** `messageId` is optional and, when given,
 *    must look like a test id. Generated ids are `msg_sim_<scenario>_<n>`, and
 *    the broadcast/chat ids are derived the same way (spec §2.6 — a simulator
 *    may not manufacture something that could pass for real participation).
 */

/** `msg_sim_…` / `msg_test_…`: an id a reader cannot mistake for a platform id. */
export const SYNTHETIC_ID_PATTERN = /^msg_(sim|test)_[A-Za-z0-9_-]{1,110}$/

const syntheticMessageId = z
  .string()
  .regex(SYNTHETIC_ID_PATTERN, 'scenario message ids must start with msg_sim_ or msg_test_')

const atMs = z.int().nonnegative()

const base = { atMs }

/** Free command as a viewer's client would already have resolved it. */
export const CommandStepSchema = z.strictObject({
  ...base,
  kind: z.literal('command'),
  command: CommandNameSchema,
  argument: z.string().nullable().default(null),
  /** Repeats of the same command at the same offset, each with its own id. */
  count: z.int().positive().max(5000).default(1),
  messageId: syntheticMessageId.optional(),
})

/**
 * A raw chat line. The runner must supply a parser; without one the step cannot
 * be built, which is what keeps unparsed text out of an envelope.
 */
export const ChatStepSchema = z.strictObject({
  ...base,
  kind: z.literal('chat'),
  text: z.string().max(4096),
  count: z.int().positive().max(5000).default(1),
  messageId: syntheticMessageId.optional(),
})

const paidBase = {
  ...base,
  messageId: syntheticMessageId.optional(),
}

export const SuperChatStepSchema = z.strictObject({
  ...paidBase,
  kind: z.literal('superChat'),
  amountMicros: z.int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  tier: z.int().positive(),
})

export const SuperStickerStepSchema = z.strictObject({
  ...paidBase,
  kind: z.literal('superSticker'),
  amountMicros: z.int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  tier: z.int().positive(),
})

export const GiftStepSchema = z.strictObject({
  ...paidBase,
  kind: z.literal('gift'),
  /** `0` is a non-combo gift and still counts as one (spec §7.4). */
  comboCount: z.int().nonnegative(),
  jewels: z.int().nonnegative(),
  giftName: z.string().regex(/^[A-Za-z0-9 _-]{1,64}$/),
})

export const MembershipStepSchema = z.strictObject({
  ...paidBase,
  kind: z.literal('membership'),
  tier: z.int().positive().nullable().default(null),
})

/** An item the adapter recognises but does not support (spec §7.3(1)). */
export const UnsupportedStepSchema = z.strictObject({
  ...paidBase,
  kind: z.literal('unsupported'),
  sourceMessageType: z.string().regex(/^[A-Za-z_]{1,64}$/),
})

/** A malformed item: it still becomes a minimal envelope (spec §7.3(1)). */
export const InvalidStepSchema = z.strictObject({
  ...paidBase,
  kind: z.literal('invalid'),
  code: ValidationErrorCodeSchema,
  field: z
    .string()
    .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/)
    .nullable()
    .default(null),
})

/**
 * An interval with no input at all (spec §2.1: the world advances with zero
 * viewers). It injects nothing and only extends how far the run has to go; the
 * runner decides in how many slices it crosses the interval.
 */
export const WaitStepSchema = z.strictObject({
  ...base,
  kind: z.literal('wait'),
  durationMs: z.int().positive(),
})

export const CONTROL_NAMES = ['degrade', 'recover'] as const
export type ControlName = (typeof CONTROL_NAMES)[number]

/**
 * Forces a broadcast-lifecycle condition (spec §9.2). `degrade` detaches the
 * renderer, which is a real degraded reason (`no_renderer`) rather than a test
 * hook poked into the engine; `recover` reattaches it.
 */
export const ControlStepSchema = z.strictObject({
  ...base,
  kind: z.literal('control'),
  control: z.enum(CONTROL_NAMES),
})

export const ScenarioStepSchema = z.discriminatedUnion('kind', [
  CommandStepSchema,
  ChatStepSchema,
  SuperChatStepSchema,
  SuperStickerStepSchema,
  GiftStepSchema,
  MembershipStepSchema,
  UnsupportedStepSchema,
  InvalidStepSchema,
  WaitStepSchema,
  ControlStepSchema,
])
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>
export type ScenarioStepInput = z.input<typeof ScenarioStepSchema>

export const ScenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'scenario id must be lower-case kebab'),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(400),
  /**
   * True when the scenario only makes sense with a virtual clock (a 24h idle
   * window, a degraded window longer than the renderer ACK timeout). The report
   * command skips these instead of waiting for real time to pass.
   */
  requiresVirtualClock: z.boolean().default(false),
  steps: z.array(ScenarioStepSchema).min(1),
})
export type Scenario = z.infer<typeof ScenarioSchema>
export type ScenarioInput = z.input<typeof ScenarioSchema>

export class ScenarioError extends Error {
  constructor(message: string) {
    super(`invalid scenario: ${message}`)
    this.name = 'ScenarioError'
  }
}

/** Parses and normalizes a scenario document, with defaults applied. */
export function parseScenario(document: unknown): Scenario {
  const parsed = ScenarioSchema.safeParse(document)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ScenarioError(
      issue === undefined ? 'unknown' : `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    )
  }
  return parsed.data
}
