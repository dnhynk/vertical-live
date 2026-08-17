#!/usr/bin/env node
/**
 * Guards the `ignore-scripts=true` in `.npmrc` (see that file for why it exists).
 *
 * Two failure modes are checked, both of which `ignore-scripts` would otherwise
 * turn into a silent problem for a later task:
 *
 * 1. A new dependency that genuinely needs its install script to work. Every
 *    package the lockfile marks with `hasInstallScript` has to be listed below
 *    with a reason why skipping it is safe.
 * 2. A platform or Node ABI for which `better-sqlite3` ships no prebuilt
 *    binding. With install scripts off nothing would build one, so the binding
 *    is loaded here and a real database is opened.
 *
 * Runs as part of `npm run lint`, not as a `postinstall`: `ignore-scripts` also
 * suppresses this repository's own lifecycle scripts.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** package name -> why the repository works without its install script. */
const ALLOWED_WITHOUT_INSTALL_SCRIPT = new Map([
  [
    'esbuild',
    'the binary comes from the @esbuild/<platform> optional dependency; postinstall only re-validates it',
  ],
  ['fsevents', 'macOS-only optional dependency; unused on the Windows host and on CI'],
  [
    'better-sqlite3',
    'ships prebuilds/<platform>.node in the tarball; npm injects node-gyp only because it cannot see "gypfile": false',
  ],
  [
    'protobufjs',
    'its postinstall (scripts/postinstall.js) only prints a warning when a dependent pins the package without the "~" range it prefers; it writes nothing and builds nothing (read at 7.6.5)',
  ],
])

const failures = []

const lockfile = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'))
for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
  if (entry.hasInstallScript !== true) continue
  const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
  if (ALLOWED_WITHOUT_INSTALL_SCRIPT.has(name)) continue
  failures.push(
    `${name} declares an install script, but .npmrc sets ignore-scripts=true. ` +
      'Confirm the package works without it and add it to ALLOWED_WITHOUT_INSTALL_SCRIPT with a reason, ' +
      'or change the install strategy.',
  )
}

// The native binding is the reason `.npmrc` exists, so prove it loads here
// rather than discovering it from a stack trace in the middle of the tests.
const require = createRequire(import.meta.url)
try {
  const Database = require('better-sqlite3')
  const probe = new Database(':memory:')
  try {
    probe.prepare('SELECT sqlite_version() AS version').get()
  } finally {
    probe.close()
  }
} catch (error) {
  failures.push(
    `better-sqlite3 has no working binding for ${process.platform}-${process.arch} on Node ${process.version} ` +
      `(${error instanceof Error ? error.message : String(error)}). ` +
      'With .npmrc ignore-scripts=true nothing compiles one, so this platform needs a version that ships a prebuild for it.',
  )
}

if (failures.length > 0) {
  console.error('check-install-scripts: failed')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `check-install-scripts: ok (${String(ALLOWED_WITHOUT_INSTALL_SCRIPT.size)} reviewed, better-sqlite3 binding loads)`,
)
