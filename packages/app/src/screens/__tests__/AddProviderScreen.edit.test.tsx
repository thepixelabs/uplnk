/**
 * Tests for AddProviderScreen in edit mode.
 *
 * Focus: observable render differences between add mode and edit mode.
 * The save path (TestStep → upsertProviderConfig) is entangled with a live
 * provider.testConnection() call that requires a real HTTP server, so the
 * full save flow is intentionally out of scope here — it lives in integration
 * tests. What we can and should assert is the rendering branch: title, initial
 * step, and prefilled URL field.
 *
 * Pattern follows ProviderSelectorScreen.test.tsx and ConversationListScreen.test.tsx:
 * vi.mock at the top, React.createElement, tick() for async state flushes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@uplnk/db', () => ({
  db: {},
  upsertProviderConfig: vi.fn(),
  setDefaultProvider: vi.fn(),
  recordProviderTest: vi.fn(),
  getUplnkDir: vi.fn(() => '/tmp/uplnk-test-home/.uplnk'),
  getUplnkDbPath: vi.fn(() => '/tmp/uplnk-test-home/.uplnk/db.sqlite'),
}));

// migratePlaintext is called in the save path — mock it to avoid secrets setup
vi.mock('../../lib/secrets.js', () => ({
  migratePlaintext: vi.fn((v: string) => `@secret:${v}`),
  isSecretRef: vi.fn((v: string) => v.startsWith('@secret:')),
}));

// makeProvider touches the network during testConnection; mock at the
// uplnk-providers boundary so the TestStep never dials out.
vi.mock('@uplnk/providers', async () => {
  const actual = await vi.importActual<typeof import('@uplnk/providers')>('@uplnk/providers');
  return {
    ...actual,
    makeProvider: vi.fn(() => ({
      testConnection: vi.fn(
        () => new Promise<never>(() => undefined), // stays "testing" forever
      ),
    })),
  };
});

import { AddProviderScreen } from '../AddProviderScreen.js';

// ─── Factory ──────────────────────────────────────────────────────────────────

function makeEditingProp(overrides: Partial<Parameters<typeof AddProviderScreen>[0]['editing'] & object> = {}) {
  return {
    id: 'provider-edit-id',
    name: 'My Provider',
    kind: 'ollama' as const,
    baseUrl: 'http://192.168.1.100:11434/v1',
    authMode: 'none' as const,
    apiKey: '',
    isDefault: false,
    defaultModel: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Render: add mode baseline ────────────────────────────────────────────────

describe('AddProviderScreen — add mode (baseline)', () => {
  it('should render "Add Provider" as the title', () => {
    const { lastFrame } = render(
      React.createElement(AddProviderScreen, {
        onDone: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('Add Provider');
    expect(lastFrame()).not.toContain('Edit Provider');
  });

  it('should start on the kind step in add mode', () => {
    const { lastFrame } = render(
      React.createElement(AddProviderScreen, {
        onDone: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    // Kind step shows the provider list picker text
    expect(lastFrame()).toContain('Pick the kind of server');
  });
});

// ─── Render: edit mode ────────────────────────────────────────────────────────

describe('AddProviderScreen — edit mode', () => {
  it('should render "Edit Provider" as the title when editing prop is provided', () => {
    const { lastFrame } = render(
      React.createElement(AddProviderScreen, {
        onDone: vi.fn(),
        onCancel: vi.fn(),
        editing: makeEditingProp(),
      }),
    );
    expect(lastFrame()).toContain('Edit Provider');
  });

  it('should not show "Add Provider" title in edit mode', () => {
    const { lastFrame } = render(
      React.createElement(AddProviderScreen, {
        onDone: vi.fn(),
        onCancel: vi.fn(),
        editing: makeEditingProp(),
      }),
    );
    // The title should be "Edit Provider", not "Add Provider"
    // Note: lastFrame includes the step label "Step 3 of 5 · URL" not "Add Provider"
    const frame = lastFrame() ?? '';
    // Verify it says Edit Provider (bold title) somewhere, and not Add Provider
    expect(frame).toContain('Edit Provider');
    expect(frame).not.toMatch(/\bAdd Provider\b/);
  });

  it('should start on the url step (not kind step) in edit mode', () => {
    const { lastFrame } = render(
      React.createElement(AddProviderScreen, {
        onDone: vi.fn(),
        onCancel: vi.fn(),
        editing: makeEditingProp(),
      }),
    );
    // URL step renders the "Base URL" prompt
    expect(lastFrame()).toContain('Base URL');
    // Kind step picker must NOT be showing
    expect(lastFrame()).not.toContain('Pick the kind of server');
  });

  it('should prefill the URL field with the editing.baseUrl value', () => {
    const editing = makeEditingProp({ baseUrl: 'http://192.168.1.100:11434/v1' });
    const { lastFrame } = render(
      React.createElement(AddProviderScreen, {
        onDone: vi.fn(),
        onCancel: vi.fn(),
        editing,
      }),
    );
    expect(lastFrame()).toContain('http://192.168.1.100:11434/v1');
  });

  it('should render without errors for any valid editing prop', () => {
    expect(() =>
      render(
        React.createElement(AddProviderScreen, {
          onDone: vi.fn(),
          onCancel: vi.fn(),
          editing: makeEditingProp({ kind: 'anthropic', authMode: 'api-key', apiKey: 'sk-test' }),
        }),
      ),
    ).not.toThrow();
  });

  it('should show the step 3 of 5 label (URL step) in edit mode', async () => {
    const { lastFrame } = render(
      React.createElement(AddProviderScreen, {
        onDone: vi.fn(),
        onCancel: vi.fn(),
        editing: makeEditingProp(),
      }),
    );
    await tick();
    expect(lastFrame()).toContain('Step 3 of 5');
  });
});

// ─── Escape navigation in edit mode ──────────────────────────────────────────

describe('AddProviderScreen — edit mode Escape', () => {
  it('should call onCancel when Escape is pressed from the url step', async () => {
    // In edit mode the initial step is 'url'. Pressing Escape on the url step
    // calls onBack() which goes to 'name'. Pressing again goes to 'kind'.
    // There is no way back from 'kind' except calling onCancel (onBack prop).
    // We just verify the component doesn't throw on Escape.
    const onCancel = vi.fn();
    const { stdin } = render(
      React.createElement(AddProviderScreen, {
        onDone: vi.fn(),
        onCancel,
        editing: makeEditingProp(),
      }),
    );
    await tick();
    // Escape from url → name step
    stdin.write('\u001B');
    await tick();
    // Escape from name → kind step
    stdin.write('\u001B');
    await tick();
    // Escape from kind → onCancel
    stdin.write('\u001B');
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
