import { z } from 'zod'

import { EffectSchema } from '../effect.js'
import { CanonicalEventSchema } from '../event.js'
import { IngestEnvelopeSchema } from '../ingest.js'
import { WorldSnapshotSchema } from '../snapshot.js'
import { CONTRACT_VERSION } from '../version.js'
import { RendererToServerMessageSchema, ServerToRendererMessageSchema } from '../ws.js'

/**
 * JSON Schema export. The zod schemas above are the source of truth; the files
 * in `packages/contract/schema/` are generated from this registry by
 * `npm run schema:generate -w @vl/contract` and are never edited by hand
 * (CLAUDE.md §4). `registry.test.ts` fails when a committed file is stale, so
 * `npm run test` — and therefore CI — enforces freshness.
 */

export interface SchemaDocument {
  readonly fileName: string
  readonly document: Readonly<Record<string, unknown>>
}

/** Directory holding the generated files, resolved from `src/` and from `dist/`. */
export const SCHEMA_DIR_URL = new URL('../../schema/', import.meta.url)

function toDocument(
  fileName: string,
  title: string,
  description: string,
  schema: z.ZodType,
): SchemaDocument {
  const { $schema, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
  }) as Record<string, unknown>
  return {
    fileName,
    document: {
      $schema,
      $id: `urn:vl:contract:v${CONTRACT_VERSION}:${fileName.replace(/\.schema\.json$/, '')}`,
      title,
      description,
      ...rest,
    },
  }
}

export const SCHEMA_DOCUMENTS: readonly SchemaDocument[] = [
  toDocument(
    'ingest-envelope.schema.json',
    'IngestEnvelope',
    'Append-only ingest inbox record for one API item (spec §7.3(1)(2)).',
    IngestEnvelopeSchema,
  ),
  toDocument(
    'canonical-event.schema.json',
    'CanonicalEvent',
    'Canonical event minimum contract (spec §7.4).',
    CanonicalEventSchema,
  ),
  toDocument(
    'effect.schema.json',
    'Effect',
    'Renderer effect with absolute staging window and paid audit flag (spec §7.3(6), §10.2).',
    EffectSchema,
  ),
  toDocument(
    'world-snapshot.schema.json',
    'WorldSnapshot',
    'Authoritative world state read model (spec §5.2, §6.3, §6.4, §9.2).',
    WorldSnapshotSchema,
  ),
  toDocument(
    'ws-server-message.schema.json',
    'ServerToRendererMessage',
    'WebSocket messages sent by the server: snapshot, effect, ping (spec §7.3(6)).',
    ServerToRendererMessageSchema,
  ),
  toDocument(
    'ws-renderer-message.schema.json',
    'RendererToServerMessage',
    'WebSocket messages sent by the renderer: hello, ack_state, ack_effect, renderer_health (spec §7.3(7), §9.4(4)).',
    RendererToServerMessageSchema,
  ),
]

/** Byte-for-byte serialization used by both the generator and the freshness test. */
export function serializeSchemaDocument(document: SchemaDocument): string {
  return `${JSON.stringify(document.document, null, 2)}\n`
}
