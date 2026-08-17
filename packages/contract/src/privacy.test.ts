import { describe, expect, it } from 'vitest'

import { SCHEMA_DOCUMENTS } from './schema/registry.js'

/**
 * TASK_SPECS §T1 acceptance 4: no type anywhere in the contract has an author,
 * display-name or channel-id field.
 *
 * The check runs over the generated JSON Schema documents rather than over a
 * hand-written list of types, so it sees every nested object of every schema —
 * including anything a later change adds — and it fails on the property name
 * itself, before any value could ever be produced.
 */

/**
 * Substrings that may not appear in a property name, case-insensitively. These
 * cover the [S3]/[S4] identity fields (`authorDetails`, `authorChannelId`,
 * `displayName`, `profileImageUrl`) and the raw-text fields the adapters
 * deliberately drop (`messageText`, `userComment`, `displayMessage`).
 */
const FORBIDDEN_NAME_PARTS = [
  'author',
  'channelid',
  'channel_id',
  'displayname',
  'display_name',
  'displaymessage',
  'display_message',
  'profileimage',
  'profile_image',
  'username',
  'user_name',
  'nickname',
  'messagetext',
  'message_text',
  'usercomment',
  'user_comment',
  'rawtext',
  'raw_text',
  'chattext',
  'handle',
  'avatar',
  'email',
]

/** Every property name that appears anywhere in a JSON Schema document. */
function collectPropertyNames(node: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) collectPropertyNames(child, found)
    return found
  }
  if (typeof node !== 'object' || node === null) return found

  const record = node as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (
      (key === 'properties' || key === 'patternProperties') &&
      typeof value === 'object' &&
      value !== null
    ) {
      for (const name of Object.keys(value as Record<string, unknown>)) found.add(name)
    }
    if (key === 'required' && Array.isArray(value)) {
      for (const name of value) if (typeof name === 'string') found.add(name)
    }
    collectPropertyNames(value, found)
  }
  return found
}

const PROPERTY_NAMES = new Map(
  SCHEMA_DOCUMENTS.map((doc) => [doc.fileName, collectPropertyNames(doc.document, new Set())]),
)

describe('no identity field exists anywhere in the contract', () => {
  it('walks a non-trivial number of property names', () => {
    // Guards the walker itself: a bug that returned nothing would make every
    // assertion below pass vacuously.
    const all = new Set([...PROPERTY_NAMES.values()].flatMap((names) => [...names]))
    expect(all.size).toBeGreaterThan(40)
    for (const expected of ['eventKey', 'validationStatus', 'payment', 'effectId', 'display']) {
      expect(all).toContain(expected)
    }
  })

  it.each([...PROPERTY_NAMES.keys()])('%s has no identity or raw-text property', (fileName) => {
    const offenders = [...(PROPERTY_NAMES.get(fileName) ?? [])].filter((name) =>
      FORBIDDEN_NAME_PARTS.some((part) => name.toLowerCase().includes(part)),
    )
    expect(offenders).toEqual([])
  })

  it('types actor as null in the canonical event schema', () => {
    const document = SCHEMA_DOCUMENTS.find((doc) => doc.fileName === 'canonical-event.schema.json')
      ?.document as { properties?: Record<string, unknown> } | undefined
    expect(document?.properties?.actor).toEqual({ type: 'null' })
  })

  it('closes every object so an identity field cannot be smuggled in', () => {
    // `additionalProperties: false` everywhere is what makes the property-name
    // check above exhaustive at runtime as well as at compile time.
    const open: string[] = []
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, `${path}[${index}]`))
        return
      }
      if (typeof node !== 'object' || node === null) return
      const record = node as Record<string, unknown>
      if (record.type === 'object' && record.additionalProperties !== false) open.push(path)
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`)
    }
    for (const doc of SCHEMA_DOCUMENTS) walk(doc.document, doc.fileName)
    expect(open).toEqual([])
  })
})
