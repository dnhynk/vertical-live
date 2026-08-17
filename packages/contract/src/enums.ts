import { z } from 'zod'

/** Which wire shape an item arrived in. gRPC and REST field names are never mixed. */
export const SourceShapeSchema = z.enum(['grpc', 'rest', 'simulator'])
export type SourceShape = z.infer<typeof SourceShapeSchema>

/** Origin of an event. `simulator` input is always labelled as synthetic (spec §2.6). */
export const EventSourceSchema = z.enum(['youtube', 'simulator'])
export type EventSource = z.infer<typeof EventSourceSchema>

/** Outcome of validating one API item (spec §7.3(1)). */
export const ValidationStatusSchema = z.enum(['valid', 'unsupported', 'invalid'])
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>

/** Canonical event kinds (spec §7.4). */
export const EventKindSchema = z.enum([
  'CHAT_COMMAND',
  'SUPER_CHAT',
  'SUPER_STICKER',
  'GIFT',
  'MEMBERSHIP',
  'SYSTEM',
])
export type EventKind = z.infer<typeof EventKindSchema>

/** Input arbitration mode (spec §6.4). */
export const InputModeSchema = z.enum(['direct', 'aggregate'])
export type InputMode = z.infer<typeof InputModeSchema>

/** Broadcast lifecycle states (spec §9.2). */
export const BroadcastLifecycleSchema = z.enum([
  'offline',
  'starting',
  'live',
  'degraded',
  'recovering',
  'safe_stopped',
])
export type BroadcastLifecycle = z.infer<typeof BroadcastLifecycleSchema>

/**
 * What a deadline does after downtime (spec §10.2). Every deadline kind picks one
 * in its content definition; the engine (T8) applies it during recovery.
 */
export const DeadlinePolicySchema = z.enum(['replay', 'coalesce', 'skip'])
export type DeadlinePolicy = z.infer<typeof DeadlinePolicySchema>
