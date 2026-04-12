import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// Override the global uplnk-db stub for these tests so we can control
// the provider list returned by listProviders.
vi.mock('uplnk-db', () => ({
  db: {},
  listProviders: vi.fn(() => []),
}));

import { vi as _vi, beforeEach } from 'vitest';
import { listProviders } from 'uplnk-db';
import { ProviderSelectorScreen } from '../ProviderSelectorScreen.js';

const makeProvider = (id: string, name: string, overrides = {}) => ({
  id,
  name,
  baseUrl: `http://${id}.local`,
  apiKey: 'key-' + id,
  defaultModel: `${id}-model`,
  isDefault: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const providers = [
  makeProvider('ollama', 'Ollama', { isDefault: true }),
  makeProvider('openai', 'OpenAI'),
  makeProvider('anthropic', 'Anthropic'),
];

beforeEach(() => {
  vi.mocked(listProviders).mockReturnValue(providers as ReturnType<typeof listProviders>);
});

// ─── Render tests ─────────────────────────────────────────────────────────────

describe('ProviderSelectorScreen — render', () => {
  it('renders without errors', () => {
    expect(() =>
      render(
        React.createElement(ProviderSelectorScreen, {
          onSelect: vi.fn(),
          onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
        }),
      ),
    ).not.toThrow();
  });

  it('shows all provider names', () => {
    const { lastFrame } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('Ollama');
    expect(lastFrame()).toContain('OpenAI');
    expect(lastFrame()).toContain('Anthropic');
  });

  it('shows default marker next to the default provider', () => {
    const { lastFrame } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('default');
  });

  it('shows navigation hint', () => {
    const { lastFrame } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('j/k');
    expect(lastFrame()).toContain('Enter');
    expect(lastFrame()).toContain('Esc');
  });

  it('shows empty-state message when no providers', () => {
    vi.mocked(listProviders).mockReturnValueOnce([]);
    const { lastFrame } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('No providers configured');
  });
});

// ─── Keyboard: Escape goes back ───────────────────────────────────────────────

describe('ProviderSelectorScreen — Escape', () => {
  it('calls onBack when Escape is pressed', async () => {
    const onBack = vi.fn();
    const { stdin } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect: vi.fn(),
        onBack,
        onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\u001B');
    await tick();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does not call onSelect when Escape is pressed', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect,
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\u001B');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// ─── Keyboard: Enter selects ──────────────────────────────────────────────────

describe('ProviderSelectorScreen — Enter selects first provider', () => {
  it('calls onSelect with first provider data', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect,
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      'ollama',
      'ollama-model',
      'http://ollama.local',
      'key-ollama',
    );
  });

  it('does not call onSelect when provider list is empty', async () => {
    vi.mocked(listProviders).mockReturnValueOnce([]);
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect,
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// ─── Keyboard: down-arrow then Enter selects second provider ─────────────────

describe('ProviderSelectorScreen — navigation + select', () => {
  it('selects second provider after one down-arrow', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect,
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\u001B[B'); // down arrow
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith(
      'openai',
      'openai-model',
      'http://openai.local',
      'key-openai',
    );
  });

  it('cursor does not go above zero', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect,
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\u001B[A'); // up arrow — already at top
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith(
      'ollama',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('cursor does not exceed provider list length', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ProviderSelectorScreen, {
        onSelect,
        onBack: vi.fn(), onAdd: vi.fn(), onEdit: vi.fn(),
      }),
    );
    await tick();
    // Press down 10 times — only 3 providers, should clamp at last
    for (let i = 0; i < 10; i++) {
      stdin.write('\u001B[B');
      await tick();
    }
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith(
      'anthropic',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });
});
