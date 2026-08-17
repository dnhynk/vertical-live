import { z } from 'zod'

import { EffectIdSchema, EffectSchema } from './effect.js'
import { IsoUtcInstantSchema } from './primitives.js'
import { WorldSnapshotSchema } from './snapshot.js'
import { CONTRACT_VERSION } from './version.js'

/**
 * WebSocket protocol on `/ws/renderer` (spec §7.3(6)(7), §9.4(4)).
 *
 * Server → renderer: `snapshot`, `effect`, `ping`.
 * Renderer → server: `hello`, `ack_state`, `ack_effect`, `renderer_health`.
 *
 * The renderer is a read model: it acknowledges what it actually applied to a
 * frame, and the server records the ACK or its expiry.
 */

export const RendererIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'renderer id must be 1-64 chars of [A-Za-z0-9_-]')
export type RendererId = z.infer<typeof RendererIdSchema>

const serverMessageBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
  /** Server send time, used to measure the commit → renderer leg (spec §7.3(8)). */
  sentAt: IsoUtcInstantSchema,
}

export const SnapshotMessageSchema = z.strictObject({
  ...serverMessageBase,
  type: z.literal('snapshot'),
  snapshot: WorldSnapshotSchema,
})

export const EffectMessageSchema = z.strictObject({
  ...serverMessageBase,
  type: z.literal('effect'),
  effect: EffectSchema,
})

/** Liveness probe; the renderer answers with `renderer_health`. */
export const PingMessageSchema = z.strictObject({
  ...serverMessageBase,
  type: z.literal('ping'),
})

export const ServerToRendererMessageSchema = z.discriminatedUnion('type', [
  SnapshotMessageSchema,
  EffectMessageSchema,
  PingMessageSchema,
])
export type ServerToRendererMessage = z.infer<typeof ServerToRendererMessageSchema>

const rendererMessageBase = {
  schemaVersion: z.literal(CONTRACT_VERSION),
}

/** First frame after connect; tells the server what the renderer still holds. */
export const HelloMessageSchema = z.strictObject({
  ...rendererMessageBase,
  type: z.literal('hello'),
  rendererId: RendererIdSchema,
  lastAppliedStateRevision: z.int().nonnegative().nullable(),
})

/** The revision the renderer actually drew (spec §7.3(7)). */
export const AckStateMessageSchema = z.strictObject({
  ...rendererMessageBase,
  type: z.literal('ack_state'),
  stateRevision: z.int().nonnegative(),
  appliedAt: IsoUtcInstantSchema,
})

/** The effect the renderer actually played; a repeat must not restart it. */
export const AckEffectMessageSchema = z.strictObject({
  ...rendererMessageBase,
  type: z.literal('ack_effect'),
  effectId: EffectIdSchema,
  appliedAt: IsoUtcInstantSchema,
})

/** Renderer health signals (spec §9.4(4)). */
export const RendererHealthMessageSchema = z.strictObject({
  ...rendererMessageBase,
  type: z.literal('renderer_health'),
  frameCounter: z.int().nonnegative(),
  fps: z.number().nonnegative(),
  webglContextLost: z.boolean(),
  lastAppliedStateRevision: z.int().nonnegative().nullable(),
  lastAppliedEffectId: EffectIdSchema.nullable(),
})

export const RendererToServerMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  AckStateMessageSchema,
  AckEffectMessageSchema,
  RendererHealthMessageSchema,
])
export type RendererToServerMessage = z.infer<typeof RendererToServerMessageSchema>
