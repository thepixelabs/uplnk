import type { ProviderConfig } from '@uplnk/db';

/** Returns a minimal valid provider row for tests */
export function makeFakeProviderRow(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-provider-id',
    name: 'Test Provider',
    providerType: 'ollama',
    baseUrl: 'http://localhost:11434',
    apiKey: null,
    defaultModel: 'test-model',
    isDefault: true,
    authMode: 'none',
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestDetail: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
