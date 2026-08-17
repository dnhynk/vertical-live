import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Workspace packages resolve to their TypeScript sources, so `vitest run`
  // works in a clean clone without `tsc --build` having emitted `dist/` first.
  // The published entry points (`package.json` `exports`) still point at `dist/`.
  resolve: {
    alias: [
      {
        find: '@vl/contract/fixtures',
        replacement: fileURLToPath(
          new URL('./packages/contract/src/fixtures/load.ts', import.meta.url),
        ),
      },
      {
        find: '@vl/contract',
        replacement: fileURLToPath(new URL('./packages/contract/src/index.ts', import.meta.url)),
      },
      // T11's simulator drives a real backend, so it imports `@vl/server` by
      // package name. From source, because the built entry point needs
      // `npm run build -w @vl/server` to have copied the migration SQL into
      // `dist/`, and `npm run test` runs before `npm run build` in CI.
      // The subpath comes first: a string `find` matches by prefix.
      {
        find: '@vl/server/input',
        replacement: fileURLToPath(new URL('./apps/server/src/input/index.ts', import.meta.url)),
      },
      {
        find: '@vl/server',
        replacement: fileURLToPath(new URL('./apps/server/src/index.ts', import.meta.url)),
      },
      {
        find: '@vl/simulator/scenario',
        replacement: fileURLToPath(
          new URL('./tools/simulator/src/scenario/index.ts', import.meta.url),
        ),
      },
      {
        find: '@vl/simulator',
        replacement: fileURLToPath(new URL('./tools/simulator/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    // One run over every workspace. Renderer tests declare `@vitest-environment
    // jsdom` per file; everything else runs in the default node environment.
    include: ['{packages,apps,tools}/*/src/**/*.test.{ts,tsx}'],
  },
})
