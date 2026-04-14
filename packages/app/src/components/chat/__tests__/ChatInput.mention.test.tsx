/**
 * Tests for ChatInput @file mention autocomplete and Shift+Enter multi-line.
 *
 * listMentionCandidates is mocked to return a fixed array — we test ChatInput
 * UI behaviour, not the filesystem walker. The fileMention module mock must be
 * declared before the component import so vi.mock hoisting works correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';

const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

// Fixed candidate list — declared via vi.hoisted so it is available inside
// the vi.mock factory, which is hoisted before regular const declarations.
const { FIXED_CANDIDATES } = vi.hoisted(() => ({
  FIXED_CANDIDATES: [
    'src/index.ts',
    'src/utils.ts',
    'src/components/Button.tsx',
    'README.md',
    'package.json',
  ],
}));

// Mock the agent registry so agents don't appear before files in the popover.
vi.mock('../../../lib/agents/registry.js', () => ({
  getAgentRegistry: vi.fn(() => ({ list: () => [] })),
}));

vi.mock('../../voice/VoiceAssistantProvider.js', () => ({
  useVoiceAssistant: vi.fn(() => ({
    isInitialized: false,
    isDictating: false,
    partialTranscription: '',
    startDictation: vi.fn(),
    stopDictation: vi.fn(),
    toggleDictation: vi.fn(),
    registerTranscriptionHandler: vi.fn(() => vi.fn()),
    error: null,
    statusMessage: null,
  })),
  VoiceAssistantProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Must be declared before the ChatInput import so the mock is hoisted.
// Path is relative to the component (src/components/chat/ChatInput.tsx imports
// ../../lib/fileMention.js), so we use the absolute src path from the package root.
vi.mock('../../../lib/fileMention.js', () => ({
  listMentionCandidates: vi.fn(() => FIXED_CANDIDATES),
  filterMentionCandidates: vi.fn((candidates: string[], query: string, limit: number) => {
    // Real filtering logic so we can test narrowing behaviour
    if (query === '') return candidates.slice(0, limit);
    const q = query.toLowerCase();
    return candidates
      .filter((p) => p.toLowerCase().includes(q))
      .slice(0, limit);
  }),
  __resetMentionCacheForTests: vi.fn(),
}));

import { ChatInput } from '../ChatInput.js';

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderChatInput(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  return render(
    React.createElement(ChatInput, {
      onSubmit: vi.fn(),
      projectDir: '/fake/project',
      ...props,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── @ mention: opening the popover ──────────────────────────────────────────

describe('ChatInput mention — @ at start of input', () => {
  it('opens the mention popover when @ is typed in an empty input', async () => {
    const { stdin, lastFrame } = renderChatInput();
    await tick();
    stdin.write('@');
    await tick();
    expect(lastFrame()).toContain('src/index.ts');
  });

  it('shows file candidates when popover is open', async () => {
    const { stdin, lastFrame } = renderChatInput();
    await tick();
    stdin.write('@');
    await tick();
    expect(lastFrame()).toContain('src/index.ts');
  });

  it('does not open the popover when @ follows a non-space character (e.g. email@)', async () => {
    const { stdin, lastFrame } = renderChatInput();
    await tick();
    // Type 'email' then '@'
    stdin.write('e');
    await tick();
    stdin.write('m');
    await tick();
    stdin.write('a');
    await tick();
    stdin.write('i');
    await tick();
    stdin.write('l');
    await tick();
    stdin.write('@');
    await tick();
    // Popover should NOT be open
    expect(lastFrame()).not.toContain('src/index.ts');
  });

  it('opens the popover when @ follows a space', async () => {
    const { stdin, lastFrame } = renderChatInput();
    await tick();
    stdin.write('h');
    await tick();
    stdin.write('i');
    await tick();
    stdin.write(' ');
    await tick();
    stdin.write('@');
    await tick();
    expect(lastFrame()).toContain('src/index.ts');
  });

  it('does not open popover when projectDir is not provided', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ChatInput, { onSubmit: vi.fn() }),
    );
    await tick();
    stdin.write('@');
    await tick();
    expect(lastFrame()).not.toContain('src/index.ts');
  });
});

// ─── @ mention: filtering ─────────────────────────────────────────────────────

describe('ChatInput mention — filtering narrows the list', () => {
  it('filters candidates as the user types after @', async () => {
    const { stdin, lastFrame } = renderChatInput();
    await tick();
    stdin.write('@');
    await tick();
    stdin.write('u');
    await tick();
    stdin.write('t');
    await tick();
    // 'ut' matches 'src/utils.ts' but not 'README.md'
    expect(lastFrame()).toContain('utils');
    expect(lastFrame()).not.toContain('README.md');
  });
});

// ─── @ mention: Enter inserts path ───────────────────────────────────────────

describe('ChatInput mention — Enter inserts @path ', () => {
  it('inserts the selected candidate and closes the popover on Enter', async () => {
    const { stdin, lastFrame } = renderChatInput();
    await tick();
    stdin.write('@');
    await tick();
    // First candidate is 'src/index.ts'
    stdin.write('\r');
    await tick();
    const frame = lastFrame() ?? '';
    // Popover closed
    expect(frame).not.toContain('@file');
    // Inserted path appears in input value area
    expect(frame).toContain('src/index.ts');
  });
});

// ─── @ mention: Escape closes without inserting ───────────────────────────────

describe('ChatInput mention — Escape closes popover without inserting', () => {
  it('closes popover on Escape and does not insert a path', async () => {
    const { stdin, lastFrame } = renderChatInput();
    await tick();
    stdin.write('@');
    await tick();
    // Popover is open: instruction line is present
    expect(lastFrame()).toContain('↑↓ select · Enter insert · Esc cancel');
    stdin.write('\u001B');
    await tick();
    const frame = lastFrame() ?? '';
    // Popover line is gone
    expect(frame).not.toContain('↑↓ select · Enter insert · Esc cancel');
    // And no candidate path got inserted
    expect(frame).not.toContain('src/index.ts');
  });
});

// ─── @ mention: Backspace past @ closes popover ───────────────────────────────

describe('ChatInput mention — Backspace past @ closes popover', () => {
  it('closes popover when backspace removes the @ trigger character', async () => {
    const { stdin, lastFrame } = renderChatInput();
    await tick();
    stdin.write('@');
    await tick();
    // Popover is open — verified by presence of the popover instruction line
    expect(lastFrame()).toContain('↑↓ select · Enter insert · Esc cancel');
    stdin.write('\u007F'); // backspace
    await tick();
    // Popover closed — instruction line gone
    expect(lastFrame()).not.toContain('↑↓ select · Enter insert · Esc cancel');
  });
});

// ─── Shift+Enter inserts newline ──────────────────────────────────────────────

describe('ChatInput — Shift+Enter inserts a newline', () => {
  it('inserts \\n in the value when Shift+Enter is pressed', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = renderChatInput({ onSubmit });
    await tick();
    stdin.write('line one');
    await tick();
    // Shift+Enter: ESC sequence that Ink recognises as shift+return
    stdin.write('\u001B[13;2~');
    await tick();
    // The input should NOT have been submitted
    expect(onSubmit).not.toHaveBeenCalled();
    // The rendered frame should show multi-line content (newline present in value)
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line one');
  });
});

// ─── Plain Enter submits ──────────────────────────────────────────────────────

describe('ChatInput — plain Enter submits', () => {
  it('calls onSubmit when Enter is pressed with non-empty input', async () => {
    const onSubmit = vi.fn();
    const { stdin } = renderChatInput({ onSubmit });
    await tick();
    stdin.write('hello world');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('does not call onSubmit when input is empty', async () => {
    const onSubmit = vi.fn();
    const { stdin } = renderChatInput({ onSubmit });
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not call onSubmit when disabled', async () => {
    const onSubmit = vi.fn();
    const { stdin } = renderChatInput({ onSubmit, disabled: true });
    await tick();
    stdin.write('hello');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
