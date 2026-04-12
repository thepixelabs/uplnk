import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],

    // Each test file that touches the database receives a fresh :memory:
    // instance via the setup utility in src/__tests__/setup.ts.
    // The global setup here runs migrations once per worker before any test
    // file in that worker is executed. Individual tests that need a clean
    // slate create their own db via createTestDb(':memory:').
    setupFiles: ['src/__tests__/setup.ts'],

    // Run DB tests in a single thread. better-sqlite3 is synchronous and
    // thread-safe per connection, but running tests in a single worker avoids
    // any WASM/native module re-initialisation overhead across worker forks.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',

      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        'src/index.ts',      // Re-export barrel
        'src/migrate.ts',    // Thin wrapper over drizzle migrator; covered
                             // implicitly by the integration suite
      ],

      thresholds: {
        // Query functions are called in every real usage path; an untested
        // query function is a silent regression waiting to be discovered in
        // production.
        'src/queries.ts': { statements: 90, branches: 80 },
        'src/schema.ts':  { statements: 85, branches: 75 },
        'src/client.ts':  { statements: 80, branches: 70 },
      },
    },
  },
});
