/**
 * Tests for ConversationListScreen.
 *
 * Mocks uplnk-db so no real SQLite is opened. Seeds a controlled
 * conversation list, then exercises keyboard navigation and search behaviour.
 *
 * Pattern mirrors ProviderSelectorScreen.test.tsx:
 *  - vi.mock('uplnk-db') at the top
 *  - makeConversation() factory
 *  - tick() to flush React state updates
 *  - stdin.write() to simulate key presses
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

vi.mock('uplnk-db', () => ({
  db: {},
  listConversations: vi.fn(() => []),
  searchConversations: vi.fn(() => []),
}));

import { listConversations, searchConversations } from 'uplnk-db';
import { ConversationListScreen } from '../ConversationListScreen.js';

// ─── Factory ──────────────────────────────────────────────────────────────────

function makeConversation(id: string, title: string, updatedAt = '2025-01-01T00:00:00.000Z') {
  return {
    id,
    title,
    updatedAt,
    createdAt: updatedAt,
    deletedAt: null,
    providerId: null,
    modelId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

const CONVERSATIONS = [
  makeConversation('conv-1', 'Refactor auth module', '2025-06-01T00:00:00.000Z'),
  makeConversation('conv-2', 'Debug webhook handler', '2025-05-01T00:00:00.000Z'),
  makeConversation('conv-3', 'Kubernetes cluster setup', '2025-04-01T00:00:00.000Z'),
];

beforeEach(() => {
  vi.mocked(listConversations).mockReturnValue(
    CONVERSATIONS as ReturnType<typeof listConversations>,
  );
  vi.mocked(searchConversations).mockReturnValue([]);
});

// ─── Render ───────────────────────────────────────────────────────────────────

describe('ConversationListScreen — render', () => {
  it('renders without errors', () => {
    expect(() =>
      render(
        React.createElement(ConversationListScreen, {
          onSelect: vi.fn(),
          onBack: vi.fn(),
        }),
      ),
    ).not.toThrow();
  });

  it('shows conversation titles in the list', () => {
    const { lastFrame } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('Refactor auth module');
    expect(lastFrame()).toContain('Debug webhook handler');
    expect(lastFrame()).toContain('Kubernetes cluster setup');
  });

  it('shows the search prompt', () => {
    const { lastFrame } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('Search:');
  });

  it('shows navigation hints', () => {
    const { lastFrame } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('navigate');
    expect(lastFrame()).toContain('Enter');
    expect(lastFrame()).toContain('Esc');
  });

  it('shows empty-state message when no conversations exist', () => {
    vi.mocked(listConversations).mockReturnValueOnce([]);
    const { lastFrame } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(),
      }),
    );
    expect(lastFrame()).toContain('No saved conversations');
  });
});

// ─── Keyboard: Escape behaviour ───────────────────────────────────────────────

describe('ConversationListScreen — Escape', () => {
  it('calls onBack when Escape is pressed with no query', async () => {
    const onBack = vi.fn();
    const { stdin } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack,
      }),
    );
    await tick();
    stdin.write('\u001B');
    await tick();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('clears query on first Escape when query is non-empty, does not call onBack', async () => {
    vi.mocked(searchConversations).mockReturnValue(
      [CONVERSATIONS[0]!] as ReturnType<typeof searchConversations>,
    );
    const onBack = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack,
      }),
    );
    await tick();
    // Type a character to populate the query
    stdin.write('a');
    await tick();
    stdin.write('\u001B');
    await tick();
    // onBack should NOT have been called
    expect(onBack).not.toHaveBeenCalled();
    // Query cleared — search box should be empty
    expect(lastFrame()).not.toContain('Search: a');
  });

  it('calls onBack on second Escape after query has been cleared', async () => {
    const onBack = vi.fn();
    const { stdin } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack,
      }),
    );
    await tick();
    stdin.write('x');
    await tick();
    stdin.write('\u001B'); // first Esc: clears query
    await tick();
    stdin.write('\u001B'); // second Esc: goes back
    await tick();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

// ─── Keyboard: Enter selects ──────────────────────────────────────────────────

describe('ConversationListScreen — Enter selects', () => {
  it('calls onSelect with the id of the first conversation on Enter', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ConversationListScreen, {
        onSelect,
        onBack: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith('conv-1');
  });

  it('calls onSelect with the second conversation id after one down-arrow', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ConversationListScreen, {
        onSelect,
        onBack: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\u001B[B'); // down arrow
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith('conv-2');
  });

  it('cursor does not go below zero on up arrow from top', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ConversationListScreen, {
        onSelect,
        onBack: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\u001B[A'); // up arrow — already at top
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith('conv-1');
  });

  it('does not call onSelect when list is empty', async () => {
    vi.mocked(listConversations).mockReturnValueOnce([]);
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ConversationListScreen, {
        onSelect,
        onBack: vi.fn(),
      }),
    );
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// ─── Search / filter ──────────────────────────────────────────────────────────

describe('ConversationListScreen — search', () => {
  it('shows no-matches message when search returns empty array', async () => {
    vi.mocked(searchConversations).mockReturnValue([]);
    const { stdin, lastFrame } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(),
      }),
    );
    await tick();
    stdin.write('z');
    await tick();
    expect(lastFrame()).toContain('No matches');
  });

  it('calls searchConversations (not listConversations) when query is non-empty', async () => {
    vi.mocked(searchConversations).mockReturnValue(
      [CONVERSATIONS[1]!] as ReturnType<typeof searchConversations>,
    );
    const { stdin } = render(
      React.createElement(ConversationListScreen, {
        onSelect: vi.fn(),
        onBack: vi.fn(),
      }),
    );
    await tick();
    stdin.write('w');
    await tick();
    expect(searchConversations).toHaveBeenCalled();
  });
});
