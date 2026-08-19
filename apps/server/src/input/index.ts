import type { AnyCommandRef, CommandParser } from '@vl/contract'

import { parseMessage, type ParserLimits } from './parse.js'
import type { CommandMetrics } from './metrics.js'
import type { ParseContext, ParseResult } from './types.js'

export { matchAlias, aliasKeys, isConsentCommandName } from './aliases.js'
export {
  InputArbiter,
  InputArbiterConfigError,
  type AggregateWindowResult,
  type CommandWindowTally,
  type ArbiterAdmission,
  type InputArbiterOptions,
  type InputPerUserConfig,
  type InputWindowConfig,
  type SuppressionReason,
} from './arbiter.js'
export {
  InputConfigError,
  loadInputConfig,
  parserLimits,
  type InputConfig,
  type LoadInputConfigOptions,
} from './config.js'
export {
  ACCEPTED_VECTORS,
  LEAK_MARKERS,
  REJECTED_VECTORS,
  type AcceptedVector,
  type RejectedVector,
} from './fixtures/adversarial.js'
export { CommandMetrics, type CommandMetricsSnapshot } from './metrics.js'
export { moderate } from './moderation.js'
export { normalizeText, type NormalizedText } from './normalize.js'
export { parseMessage, type ParserLimits } from './parse.js'
export {
  REJECTION_REASONS,
  type ParseContext,
  type ParsedCommand,
  type ParsedConsentCommand,
  type ParseResult,
  type Rejection,
  type RejectionReason,
} from './types.js'

export interface CommandParserPortOptions {
  /** Reads the live gate/window state each time a message arrives. */
  readonly context: () => ParseContext
  readonly limits: ParserLimits
  /** Optional counter for the "명령 성공" metric (spec §14.1). */
  readonly metrics?: CommandMetrics
}

/**
 * Adapts the parser to `@vl/contract`'s `CommandParser` port, which the source
 * adapters call with raw chat text and which may only ever hand back a command
 * or `null` (spec §7.3(1)). The rejection code is counted here and goes no
 * further: nothing about a rejected message crosses into an envelope.
 *
 * A consent command leaves through the same port (BOARD D-9); the contract's
 * `buildValidEnvelope` is what files it under `consentCommand` rather than
 * `command`, so the split survives the boundary instead of depending on this
 * function's caller.
 */
export function createCommandParserPort(options: CommandParserPortOptions): CommandParser {
  return (rawText: string): AnyCommandRef | null => {
    const result: ParseResult = parseMessage(rawText, options.context(), options.limits)
    options.metrics?.recordParse(result)
    if (result.status === 'accepted') return result.command
    if (result.status === 'accepted_consent') return result.consentCommand
    return null
  }
}
