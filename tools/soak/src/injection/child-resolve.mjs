import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Module resolution for the crash child (`crash-child.ts`).
 *
 * The child has to run the **real** engine and the **real** store — that is the
 * whole point of a process-boundary crash — and it must be able to do so during
 * `npm run test`, which CI runs *before* `npm run build`. So it cannot import
 * `@vl/server` through its package entry point: that points at `dist/`, which
 * does not exist yet at that moment.
 *
 * Two hooks make the source tree importable instead, and Node 24's built-in
 * TypeScript type stripping does the rest:
 *
 * 1. the workspace package names map to their `src/` entry points, the same way
 *    `vitest.config.ts` aliases them for the tests;
 * 2. a relative `./x.js` specifier that has no `.js` on disk resolves to `./x.ts`.
 *    The repository's TypeScript sources import each other with `.js` extensions
 *    (NodeNext), and Node does not rewrite them on its own.
 *
 * `VL_REPO_ROOT` is passed by `crash.ts` so neither hook has to guess where the
 * repository is.
 */

const ROOT = process.env['VL_REPO_ROOT']

const WORKSPACE_ENTRY_POINTS = {
  '@vl/contract': 'packages/contract/src/index.ts',
  '@vl/contract/fixtures': 'packages/contract/src/fixtures/load.ts',
  '@vl/server': 'apps/server/src/index.ts',
  '@vl/server/input': 'apps/server/src/input/index.ts',
  '@vl/server/obs': 'apps/server/src/obs/index.ts',
  '@vl/server/supervisor': 'apps/server/src/supervisor/index.ts',
}

export async function resolve(specifier, context, next) {
  const entry = WORKSPACE_ENTRY_POINTS[specifier]
  if (entry !== undefined) {
    if (ROOT === undefined) throw new Error('VL_REPO_ROOT is not set for the crash child')
    return { url: pathToFileURL(`${ROOT}/${entry}`).href, shortCircuit: true }
  }

  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const asPath = fileURLToPath(new URL(specifier, context.parentURL))
    if (!existsSync(asPath)) {
      const asTypeScript = `${asPath.slice(0, -'.js'.length)}.ts`
      if (existsSync(asTypeScript)) {
        return { url: pathToFileURL(asTypeScript).href, shortCircuit: true }
      }
    }
  }

  return next(specifier, context)
}
