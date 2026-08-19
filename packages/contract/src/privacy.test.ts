import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { SCHEMA_DOCUMENTS } from './schema/registry.js'

/**
 * The identity rule the contract enforces, revised for BOARD D-9 (2026-08-19):
 * Gate 0 §1.3 chose option (B), so a viewer who opted in with `JOIN` has a
 * display name stored and shown, and **only** such a viewer does. Everyone else
 * is exactly as anonymous as they were while the gate was closed.
 *
 * Concretely (TASK_SPECS §T20a acceptance 1, spec §7.4, §12.4):
 *
 *  - the one shape allowed to carry a name is `ConsentedActor`
 *    (`{kind:'consented', displayName, channelRef}`), and it appears only where
 *    D-9 puts it: the canonical event and the free action-reaction effect;
 *  - the raw `channelId` has no field at all — the opaque `channelRef` is what
 *    travels — and no 24-character `UC…` channel id appears anywhere in the
 *    package, schema and fixtures included;
 *  - every other author, name and raw-text field is still absent everywhere.
 *
 * Two surfaces are checked, because a value can travel through either. The
 * generated JSON Schema documents cover everything that is validated or
 * persisted at runtime, and the emitted TypeScript declarations cover the types
 * consumers compile against — including the assembly types that never appear in
 * a JSON Schema at all.
 */

/**
 * Substrings that may not appear in a property name, case-insensitively. These
 * cover the [S3]/[S4] identity fields (`authorDetails`, `authorChannelId`,
 * `displayName`, `profileImageUrl`) and the raw-text fields the adapters
 * deliberately drop (`messageText`, `userComment`, `displayMessage`).
 *
 * `displayname` stays on the list: it is exempted for the consented actor by
 * shape, at the node that declares it, and nowhere else.
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
  'commandtext',
  'command_text',
  'handle',
  'avatar',
  'email',
]

/** Property set of `ConsentedActor`, the one shape D-9 allows to hold a name. */
const CONSENTED_ACTOR_PROPERTIES = ['channelRef', 'displayName', 'kind']

function properties(node: Record<string, unknown>): Record<string, unknown> | null {
  const value = node.properties
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * True for an object schema that is exactly `ConsentedActor`. "Exactly" is the
 * point: an extra property — say a `channelId` slipped in beside the reference —
 * makes this false, so the node loses its exemption and the name check below
 * fails on it.
 */
function isConsentedActorSchema(node: Record<string, unknown>): boolean {
  const bag = properties(node)
  if (bag === null) return false
  if (Object.keys(bag).sort().join(',') !== CONSENTED_ACTOR_PROPERTIES.join(',')) return false
  const kind = bag.kind
  return typeof kind === 'object' && kind !== null && (kind as Record<string, unknown>).const === 'consented'
}

interface SchemaScan {
  /** Every property name outside a consented actor. */
  readonly propertyNames: Set<string>
  /** Object nodes shaped exactly like `ConsentedActor`. */
  consentedActors: number
  /** Object nodes declaring a `displayName` property, wherever they are. */
  displayNameOwners: number
}

function newScan(): SchemaScan {
  return { propertyNames: new Set(), consentedActors: 0, displayNameOwners: 0 }
}

/**
 * Walks a JSON Schema document, harvesting every property name except the ones
 * a consented actor is allowed to declare, and counting both consented actors
 * and display-name owners so the two can be compared.
 */
function scanDocument(node: unknown, out: SchemaScan): SchemaScan {
  if (Array.isArray(node)) {
    for (const child of node) scanDocument(child, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out

  const record = node as Record<string, unknown>
  const consented = isConsentedActorSchema(record)
  if (consented) out.consentedActors += 1
  if (properties(record)?.displayName !== undefined) out.displayNameOwners += 1

  for (const [key, value] of Object.entries(record)) {
    if (!consented) {
      if (
        (key === 'properties' || key === 'patternProperties') &&
        typeof value === 'object' &&
        value !== null
      ) {
        for (const name of Object.keys(value as Record<string, unknown>)) out.propertyNames.add(name)
      }
      if (key === 'required' && Array.isArray(value)) {
        for (const name of value) if (typeof name === 'string') out.propertyNames.add(name)
      }
    }
    scanDocument(value, out)
  }
  return out
}

const SCANS = new Map(
  SCHEMA_DOCUMENTS.map((doc) => [doc.fileName, scanDocument(doc.document, newScan())]),
)

function scanOf(fileName: string): SchemaScan {
  const scan = SCANS.get(fileName)
  if (scan === undefined) throw new Error(`no scan for ${fileName}`)
  return scan
}

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))

/** Every `.ts` of the package except the tests, which ship to nobody. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`
    if (entry.isDirectory()) return sourceFiles(`${path}/`)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

const SCANNED_EXTENSIONS = ['.ts', '.mjs', '.json', '.md']
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist'])

/** Every text file the package ships or generates: sources, schema, fixtures. */
function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : textFiles(`${path}/`)
    }
    return SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : []
  })
}

/**
 * A YouTube channel id is `UC` followed by 22 base64url characters
 * ([S3] `authorDetails.channelId`), so this is what one looks like written down.
 * The synthetic ids the fixtures use (`UC_TEST_SYNTHETIC_0001`, 22 characters)
 * are deliberately too short to match — they are obviously fabricated values,
 * not something that could be mistaken for a captured id (spec §2.6).
 */
const CHANNEL_ID_PATTERN = /UC[A-Za-z0-9_-]{22}/

/** Declaration forms whose name is part of the published type surface. */
function isNamedTypeSurface(node: ts.Node): node is ts.NamedDeclaration {
  return (
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isVariableDeclaration(node)
  )
}

/**
 * Emits the package's `.d.ts` in memory and returns every declared member and
 * type name in them.
 *
 * Function *parameters* are deliberately not collected: `CommandParser` takes
 * the chat line the T6 parser normalizes, which is the one place text is handed
 * in rather than carried. Everything that can hold a value is collected.
 */
function collectDeclaredNames(): Set<string> {
  const program = ts.createProgram(sourceFiles(SRC_DIR), {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    declaration: true,
    emitDeclarationOnly: true,
    noEmitOnError: false,
  })

  const found = new Set<string>()
  const emitted: string[] = []
  program.emit(undefined, (fileName, text) => {
    if (!fileName.endsWith('.d.ts')) return
    emitted.push(fileName)
    const declaration = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2023, true)
    const visit = (node: ts.Node): void => {
      if (isNamedTypeSurface(node) && node.name !== undefined) {
        found.add(node.name.getText(declaration).replaceAll(/['"]/g, ''))
      }
      ts.forEachChild(node, visit)
    }
    visit(declaration)
  })
  if (emitted.length === 0) throw new Error('no declaration files were emitted')
  return found
}

const DECLARED_NAMES = collectDeclaredNames()

/**
 * The complete set of declared names that name a display name, all of them the
 * consented-identity contract of D-9 (`identity.ts`). The declaration check
 * asserts equality rather than inclusion, so a new identity-shaped name has to
 * be added here deliberately — and a removed one has to be taken out.
 */
const CONSENTED_IDENTITY_NAMES = [
  'DISPLAY_NAME_MAX_LENGTH',
  'DisplayName',
  'DisplayNameSchema',
  'displayName',
]

describe('identity exists in the contract only for consenting viewers (BOARD D-9)', () => {
  it('walks a non-trivial number of property names', () => {
    // Guards the walker itself: a bug that returned nothing would make every
    // assertion below pass vacuously.
    const all = new Set([...SCANS.values()].flatMap((scan) => [...scan.propertyNames]))
    expect(all.size).toBeGreaterThan(40)
    for (const expected of ['eventKey', 'validationStatus', 'payment', 'effectId', 'display']) {
      expect(all).toContain(expected)
    }
  })

  it.each([...SCANS.keys()])(
    '%s has no identity or raw-text property outside a consented actor',
    (fileName) => {
      const offenders = [...scanOf(fileName).propertyNames].filter((name) =>
        FORBIDDEN_NAME_PARTS.some((part) => name.toLowerCase().includes(part)),
      )
      expect(offenders).toEqual([])
    },
  )

  it.each([...SCANS.keys()])('%s carries a display name only in a consented actor', (fileName) => {
    const scan = scanOf(fileName)
    expect(scan.displayNameOwners).toBe(scan.consentedActors)
  })

  it('places the consented actor exactly where D-9 allows a name', () => {
    // The canonical event carries it (spec §7.4), the free action reaction
    // effect carries it onto the screen, and the server→renderer message
    // carries that effect. The snapshot and the ingest envelope must not: a
    // read model recovers fine anonymously, and the inbox is append-only while
    // `LEAVE` deletes immediately (TASK_SPECS §T20a).
    const carriers = [...SCANS.entries()]
      .filter(([, scan]) => scan.consentedActors > 0)
      .map(([fileName]) => fileName)
    expect(carriers).toEqual([
      'canonical-event.schema.json',
      'effect.schema.json',
      'ws-server-message.schema.json',
    ])
  })

  it('types actor as null or a consented actor in the canonical event schema', () => {
    const document = SCHEMA_DOCUMENTS.find((doc) => doc.fileName === 'canonical-event.schema.json')
      ?.document as { properties?: Record<string, unknown> } | undefined
    expect(document?.properties?.actor).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'consented' },
            displayName: { type: 'string', pattern: '^[^\\p{Cc}\\p{Zl}\\p{Zp}]{1,100}$' },
            channelRef: { type: 'string', pattern: '^ref_[0-9a-f]{32}$' },
          },
          required: ['kind', 'displayName', 'channelRef'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    })
  })

  it('has no channel id anywhere in the package, schema and fixtures included', () => {
    // Acceptance 1 of TASK_SPECS §T20a. The opaque `channelRef` is what the
    // contract carries; a real channel id must not be storable, renderable or
    // even present as an example.
    const files = textFiles(PACKAGE_DIR)
    expect(files.length).toBeGreaterThan(40)
    const offenders = files.filter((file) => CHANNEL_ID_PATTERN.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('has no raw-text field in the emitted TypeScript declarations either', () => {
    // The JSON Schema walker above cannot see a TypeScript-only type: an
    // adapter assembly interface is compiled into `dist/**/*.d.ts` and shipped
    // to every consumer without ever reaching a schema. So the declarations are
    // emitted here — from source, so the check does not depend on a prior
    // build — and every member and declaration name in them is checked.
    const names = DECLARED_NAMES

    // Guards the collector: an empty result would make the assertion vacuous.
    expect(names.size).toBeGreaterThan(80)
    for (const expected of ['NormalizedItemFacts', 'occurredAt', 'payment', 'parseCommand']) {
      expect(names).toContain(expected)
    }

    const offenders = [...names]
      .filter((name) => FORBIDDEN_NAME_PARTS.some((part) => name.toLowerCase().includes(part)))
      .sort()
    // Every name that reads like an identity field is one of D-9's, and every
    // one of D-9's is still there.
    expect(offenders).toEqual(CONSENTED_IDENTITY_NAMES)
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
