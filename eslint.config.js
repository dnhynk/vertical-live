import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier/flat'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    // Prototype snapshot kept for reference only (spec §10.4). It is off the product
    // path; `npm run lint` instead proves no workspace imports it.
    'legacy/**',
  ]),

  // TypeScript workspaces: @vl/contract, @vl/server, @vl/simulator.
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // Repo-level ESM tooling that runs on Node.
  {
    files: [
      'scripts/**/*.mjs',
      '{packages,apps,tools}/*/scripts/**/*.mjs',
      'eslint.config.js',
      'apps/renderer/vite.config.js',
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // @vl/renderer browser sources. Rules preserved from the prototype config;
  // the TypeScript migration is T5.
  {
    files: ['apps/renderer/src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },

  prettier,
])
