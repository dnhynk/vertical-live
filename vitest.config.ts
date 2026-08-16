import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // One run over every workspace. Renderer tests (jsdom) arrive with T5.
    include: ['{packages,apps,tools}/*/src/**/*.test.ts'],
  },
})
