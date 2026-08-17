/**
 * Copies `src/db/migrations/*.sql` into `dist/db/migrations/`.
 *
 * `tsc --build` only emits the files it compiles, and the migration runner
 * resolves its directory relative to its own module URL so the same code works
 * from `src` (vitest) and from `dist` (`npm start`). Without this step a built
 * server would start with an empty migration set.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const source = join(packageRoot, 'src', 'db', 'migrations')
const target = join(packageRoot, 'dist', 'db', 'migrations')

if (!existsSync(source)) {
  process.stderr.write(`missing migrations directory: ${source}\n`)
  process.exit(1)
}

// The target is replaced, not merged into. A renamed or deleted migration used to
// survive in `dist` and would then be applied by a built server even though no
// source file describes it — which is the exact failure `migrate.ts` refuses to
// start on. Found when T10's migration was renumbered (review round 1, m2).
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })

const expected = readdirSync(source).filter((name) => name.endsWith('.sql'))
const copied = readdirSync(target).filter((name) => name.endsWith('.sql'))
if (copied.length === 0) {
  process.stderr.write(`no .sql files copied from ${source}\n`)
  process.exit(1)
}
if (copied.length !== expected.length) {
  process.stderr.write(
    `dist holds ${String(copied.length)} migration(s) but src has ${String(expected.length)}\n`,
  )
  process.exit(1)
}
process.stdout.write(`copied ${String(copied.length)} migration(s) to dist/db/migrations\n`)
