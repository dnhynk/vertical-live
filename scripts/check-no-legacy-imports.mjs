#!/usr/bin/env node
/**
 * Acceptance criterion 4 of TASK_SPECS §T0: nothing under `legacy/` may be
 * imported from a workspace. `legacy/` holds the prototype snapshot that spec
 * §10.4 removes from the V1 product path, so this runs as part of `npm run lint`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const legacyRoot = join(repoRoot, 'legacy')

const SCAN_ROOTS = ['packages', 'apps', 'tools', 'scripts']
const SCAN_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git'])

const SPECIFIER_PATTERNS = [
  /(?:^|[\s;}])(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function collectFiles(directory, found = []) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      collectFiles(join(directory, entry.name), found)
      continue
    }
    if (SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(join(directory, entry.name))
    }
  }

  return found
}

function isLegacySpecifier(specifier, fromFile) {
  if (/(^|\/)legacy(\/|$)/.test(specifier)) return true
  if (!specifier.startsWith('.')) return false

  const resolved = resolve(dirname(fromFile), specifier)
  return resolved === legacyRoot || resolved.startsWith(legacyRoot + sep)
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

const violations = []

for (const root of SCAN_ROOTS) {
  const absoluteRoot = join(repoRoot, root)
  try {
    if (!statSync(absoluteRoot).isDirectory()) continue
  } catch {
    continue
  }

  for (const file of collectFiles(absoluteRoot)) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(source)) !== null) {
        const specifier = match[1]
        if (isLegacySpecifier(specifier, file)) {
          violations.push({
            file: relative(repoRoot, file).split(sep).join('/'),
            line: lineOf(source, match.index),
            specifier,
          })
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('legacy/ must not be imported from any workspace (spec §10.4):')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} imports '${violation.specifier}'`)
  }
  process.exit(1)
}

console.log('check-no-legacy-imports: ok (0 legacy imports)')
