import type { Config } from '../../lib/config.js';

/** Returns a minimal valid Config for tests */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    theme: 'dark',
    telemetry: { enabled: false },
    providers: [],
    mcp: {
      allowedPaths: [],
      commandExecEnabled: false,
      commandAllowlistAdditions: [],
      servers: [],
    },
    git: { enabled: false },
    rag: { enabled: false, autoDetect: false },
    relayMode: { enabled: false },
    networkScanner: { timeoutMs: 2000, concurrency: 4 },
    updates: { enabled: false, packageName: 'uplnk' },
    headless: { persist: false },
    flows: {
      dir: '/tmp/test-flows',
      autoReload: false,
      defaultTimeoutMs: 30000,
      allowShellStep: false,
      allowHttpStep: false,
      httpAllowlist: [],
      concurrency: 1,
    },
    robotic: {
      enabled: false,
      transport: 'auto',
      maxTurns: 5,
      turnTimeoutMs: 5000,
      minInterTurnMs: 0,
      judge: { provider: 'test-provider', model: 'test-model', everyNTurns: 1 },
      redact: { envPatterns: [], customPatterns: [] },
      targets: {},
    },
    altergo: {
      binary: 'altergo',
      home: '/tmp/test-altergo',
      autoImport: false,
      autoImportAccounts: [],
      watchSessions: false,
      launchDetach: true,
    },
    ...overrides,
  };
}
