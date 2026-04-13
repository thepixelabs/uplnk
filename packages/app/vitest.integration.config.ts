import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Integration test config.
 *
 * Runs only files matching `*.integration.test.ts(x)` and intentionally does
 * NOT load the global unit-test setup (src/__tests__/setup.ts) so integration
 * tests can exercise real DB / real filesystem / real network boundaries.
 *
 * As of now there are no integration tests in the tree — running this config
 * will exit with "No test files found", which is the correct no-op behaviour
 * the `pnpm test:integration` script expects. New integration tests should
 * be named `<name>.integration.test.ts` and placed alongside the code they
 * exercise.
 */
export default defineConfig({
  resolve: {
    alias: {
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
    environment: 'node',
    include: ['src/**/*.integration.test.{ts,tsx}'],
    // No setupFiles — integration tests manage their own environment.
    isolate: true,
    // Integration suites typically need longer timeouts than unit tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: true,
  },
});
