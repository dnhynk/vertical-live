import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { SCHEMA_DOCUMENTS } from './schema/registry.js'

/**
 * TASK_SPECS §T1 acceptance 4: no type anywhere in the contract has an author,
 * display-name, channel-id or raw-text field.
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

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Every `.ts` of the package except the tests, which ship to nobody. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`
    if (entry.isDirectory()) return sourceFiles(`${path}/`)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

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

    const offenders = [...names].filter((name) =>
      FORBIDDEN_NAME_PARTS.some((part) => name.toLowerCase().includes(part)),
    )
    expect(offenders).toEqual([])
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
