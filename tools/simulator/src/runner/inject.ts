import type { IngestEnvelope } from '@vl/contract'

/**
 * The only way a scenario reaches the world: `POST /ingest/simulator`, over real
 * HTTP, with the bearer token (TASK_SPECS 공통 규약, §T11).
 *
 * There is no in-process shortcut on purpose. The endpoint's refusals — 404 while
 * `simulator.enabled` is false, 403 off loopback, 401 without the token, 400 for
 * a body the envelope schema rejects — are part of what T11 has to exercise, and
 * a direct call into the engine would skip every one of them.
 */

export interface InjectTarget {
  /** `http://127.0.0.1:<port>`; loopback only (spec §10.2). */
  readonly baseUrl: string
  readonly token: string | null
}

export interface InjectResponse {
  readonly status: number
  readonly accepted: number
  readonly inserted: number
  readonly duplicates: number
  readonly lastIngestSeq: number | null
  /** Contract-vocabulary error token; never an echo of the body (spec §12.3). */
  readonly error: string | null
}

/**
 * Largest number of envelopes in one POST. The endpoint accepts up to 1 MB of
 * JSON; splitting a flood keeps a burst well inside that without the scenario
 * having to know the transport's limit.
 */
export const MAX_ENVELOPES_PER_POST = 400

export async function postEnvelopes(
  target: InjectTarget,
  envelopes: readonly IngestEnvelope[],
): Promise<InjectResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (target.token !== null) headers['authorization'] = `Bearer ${target.token}`
  const response = await fetch(`${target.baseUrl}/ingest/simulator`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ envelopes }),
  })
  const body: unknown = await response.json().catch(() => null)
  return readResponse(response.status, body)
}

/** Posts a batch in chunks and adds the results up. */
export async function postEnvelopeBatch(
  target: InjectTarget,
  envelopes: readonly IngestEnvelope[],
): Promise<InjectResponse[]> {
  const responses: InjectResponse[] = []
  for (let offset = 0; offset < envelopes.length; offset += MAX_ENVELOPES_PER_POST) {
    responses.push(
      await postEnvelopes(target, envelopes.slice(offset, offset + MAX_ENVELOPES_PER_POST)),
    )
  }
  return responses
}

function readResponse(status: number, body: unknown): InjectResponse {
  const record = isRecord(body) ? body : {}
  return {
    status,
    accepted: readInt(record['accepted']),
    inserted: readInt(record['inserted']),
    duplicates: readInt(record['duplicates']),
    lastIngestSeq: typeof record['lastIngestSeq'] === 'number' ? record['lastIngestSeq'] : null,
    error: typeof record['error'] === 'string' ? record['error'] : null,
  }
}

function readInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
