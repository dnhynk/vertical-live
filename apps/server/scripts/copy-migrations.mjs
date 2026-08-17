/**
 * Copies `src/db/migrations/*.sql` into `dist/db/migrations/`.
 *
 * `tsc --build` only emits the files it compiles, and the migration runner
 * resolves its directory relative to its own module URL so the same code works
 * from `src` (vitest) and from `dist` (`npm start`). Without this step a built
 * server would start with an empty migration set.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const source = join(packageRoot, 'src', 'db', 'migrations')
const target = join(packageRoot, 'dist', 'db', 'migrations')

if (!existsSync(source)) {
  process.stderr.write(`missing migrations directory: ${source}\n`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })

const copied = readdirSync(target).filter((name) => name.endsWith('.sql'))
if (copied.length === 0) {
  process.stderr.write(`no .sql files copied from ${source}\n`)
  process.exit(1)
}
process.stdout.write(`copied ${String(copied.length)} migration(s) to dist/db/migrations\n`)
