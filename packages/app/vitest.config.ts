import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages from source so tests do not require a
      // prior build step. Vitest loads TypeScript directly via esbuild.
      'uplnk-db': resolve(__dirname, '../db/src/index.ts'),
      'uplnk-shared': resolve(__dirname, '../shared/src/index.ts'),
      'uplnk-catalog': resolve(__dirname, '../catalog/src/index.ts'),
      'uplnk-providers': resolve(__dirname, '../providers/src/index.ts'),
      '@uplnk/db': resolve(__dirname, '../db/src/index.ts'),
      '@uplnk/shared': resolve(__dirname, '../shared/src/index.ts'),
      '@uplnk/catalog': resolve(__dirname, '../catalog/src/index.ts'),
      '@uplnk/providers': resolve(__dirname, '../providers/src/index.ts'),
    },
  },
  test: {
    // CLI app — NEVER jsdom. Ink renders to stdout strings, not a DOM.
    // @testing-library/react's renderHook does NOT require jsdom — it works
    // in the node environment. The two test files that carry a per-file
    // `// @vitest-environment jsdom` directive (useStream.test.ts and
    // useConversation.test.ts) can have that directive removed; they work
    // identically under node. The directive was added when this config
    // incorrectly specified jsdom as the default, and was never needed.
    environment: 'node',

    // Unit + component tests co-located with source under src/
    include: ['src/**/*.test.{ts,tsx}'],
    // Integration tests have their own config (vitest.integration.config.ts).
    // *.bun.test.ts files import bun:sqlite directly (via real @uplnk/db) and
    // cannot run under vitest's Node-based worker pool — they are run separately
    // via `bun test` through the test:bun npm script.
    exclude: [
      'src/**/*.integration.test.{ts,tsx}',
      'src/**/*.bun.test.{ts,tsx}',
    ],

    // Global setup: mock node:os homedir and configure in-memory DB before
    // any test module is imported. Keeps individual test files free of
    // repetitive environment scaffolding.
    setupFiles: ['src/__tests__/setup.ts'],

    // Isolate module registry between test files: vi.mock() side-effects
    // registered in one file must not affect the next.
    isolate: true,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',

      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/index.ts',       // Re-export barrels carry no logic
        'src/__tests__/**',  // Test files themselves are not coverage targets
        'src/**/__tests__/**',
      ],

      thresholds: {
        // Security + error-taxonomy: high bar — an uncovered branch here means
        // a user sees a wrong or missing error message / sandbox bypass.
        'src/lib/errors.ts':       { statements: 95, branches: 90 },
        'src/lib/mcp/security.ts': { statements: 95, branches: 90 },
        // Core application logic
        'src/lib/config.ts':       { statements: 85, branches: 80 },
        'src/lib/syntax.ts':       { statements: 80, branches: 75 },
        // Hooks: stateful async state machines — full branch coverage is
        // expensive; 75% catches the common-path regressions.
        'src/hooks':               { statements: 75, branches: 70 },
        // Components: smoke + behavioral keyboard tests is sufficient at this
        // stage; rendering failures are visible in manual testing.
        'src/components':          { statements: 70, branches: 65 },
      },
    },
  },
});
