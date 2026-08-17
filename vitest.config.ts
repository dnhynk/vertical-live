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
    ],
  },
  test: {
    // One run over every workspace. Renderer tests declare `@vitest-environment
    // jsdom` per file; everything else runs in the default node environment.
    include: ['{packages,apps,tools}/*/src/**/*.test.{ts,tsx}'],
  },
})
