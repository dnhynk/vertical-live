import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // The `?mode=dev` injection panel (T11) builds its envelopes from the
      // simulator's browser-safe scenario layer. It is resolved to the
      // TypeScript source rather than to `dist/`, for the same reason
      // `vitest.config.ts` does it: `npm run build --workspaces` visits
      // `tools/*` after `apps/*`, so a clean build would otherwise have to
      // depend on `tsc --build` having run first. The package `exports` entry
      // still points at `dist/`, which is what `tsc --build` typechecks against.
      {
        find: '@vl/simulator/scenario',
        replacement: fileURLToPath(
          new URL('../../tools/simulator/src/scenario/index.ts', import.meta.url),
        ),
      },
    ],
  },
})
