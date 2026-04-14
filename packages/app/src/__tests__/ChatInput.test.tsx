/**
 * Tests for ChatInput component.
 *
 * Input simulation: ink-testing-library exposes a `stdin` object whose
 * `.write(rawBytes)` method feeds data directly into Ink's keypress parser.
 * We therefore send raw terminal sequences (the same bytes a real TTY emits)
 * rather than constructing synthetic Key objects. This tests observable
 * behaviour — what the user sees — not internal implementation details.
 *
 * Key sequences used throughout:
 *   '\r'        → Enter / return
 *   '\x7f'      → Backspace (DEL, most modern terminals)
 *   '\x1b[A'    → Up arrow
 *   '\x1b[B'    → Down arrow
 *   '\x03'      → Ctrl+C  (ctrl combo that must be swallowed)
 *   '\x1bx'     → Meta+x  (meta combo that must be swallowed)
 *
 * useStream hook tests live in src/__tests__/useStream.test.ts.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ChatInput } from '../components/chat/ChatInput.js';

vi.mock('../components/voice/VoiceAssistantProvider.js', () => ({
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait one macrotask so React's state batching and Ink's render queue flush.
 * Using setImmediate (Node macrotask) is important: promises alone (microtasks)
 * do not give Ink's Scheduler enough time to commit the frame.
 */
const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

/**
 * Build a rendered ChatInput instance with spy callbacks and return it
 * asynchronously.
 *
 * Why the ready tick? Ink registers its stdin keypress listener
 * asynchronously after the first render cycle. If we write to stdin before
 * that listener is wired up the first byte is silently dropped. Awaiting
 * one tick after `render()` ensures the listener is active.
 */
async function renderChatInput(overrides: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const onSubmit = vi.fn<(text: string) => void>();
  const onCommand = vi.fn<(command: string) => void>();

  const instance = render(
    <ChatInput
      onSubmit={onSubmit}
      onCommand={onCommand}
      disabled={false}
      {...overrides}
    />,
  );

  // Give Ink one macrotask to wire up its stdin listener before any writes.
  await tick();

  /** Type a sequence of characters one by one. */
  const typeText = async (text: string) => {
    for (const char of text) {
      instance.stdin.write(char);
      await tick();
    }
  };

  /** Send a raw escape sequence as a single write (arrow keys, ctrl chords). */
  const sendRaw = async (seq: string) => {
    instance.stdin.write(seq);
    await tick();
  };

  return { ...instance, onSubmit, onCommand, typeText, sendRaw };
}

// ---------------------------------------------------------------------------
// ChatInput — basic rendering
// ---------------------------------------------------------------------------

describe('ChatInput rendering', () => {
  afterEach(cleanup);

  it('renders the prompt glyph in the idle (empty) state', async () => {
    const { lastFrame } = await renderChatInput();
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('❯');
  });

  it('renders the cursor indicator when input is empty and not disabled', async () => {
    const { lastFrame } = await renderChatInput();
    await tick();
    const frame = lastFrame() ?? '';
    // Cursor glyph │ must appear when field is empty and active
    expect(frame).toContain('│');
  });

  it('renders the placeholder hint text when empty and active', async () => {
    const { lastFrame } = await renderChatInput();
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('type a message');
  });

  it('renders a streaming indicator when disabled=true and field is empty', async () => {
    const { lastFrame } = await renderChatInput({ disabled: true });
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('streaming');
  });

  it('renders typed text in the input area', async () => {
    const { lastFrame, typeText } = await renderChatInput();
    await typeText('hello');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hello');
  });

  it('appends the cursor glyph after typed text', async () => {
    const { lastFrame, typeText } = await renderChatInput();
    await typeText('hi');
    const frame = lastFrame() ?? '';
    // Both the text and cursor must appear on the same logical line
    expect(frame).toContain('hi');
    expect(frame).toContain('│');
  });
});

// ---------------------------------------------------------------------------
// ChatInput — character input
// ---------------------------------------------------------------------------

describe('ChatInput character input', () => {
  afterEach(cleanup);

  it('appends each typed character to the display', async () => {
    const { lastFrame, typeText } = await renderChatInput();
    await typeText('abc');
    expect(lastFrame()).toContain('abc');
  });

  it('does not append a character when a ctrl combo is pressed', async () => {
    const { lastFrame, sendRaw } = await renderChatInput();
    // Ctrl+C → raw byte 0x03
    await sendRaw('\x03');
    const frame = lastFrame() ?? '';
    // No printable character should have been appended; field still shows hint
    expect(frame).toContain('type a message');
  });

  it('does not append a character when a meta combo is pressed', async () => {
    const { lastFrame, sendRaw } = await renderChatInput();
    // ESC + single char → meta key
    await sendRaw('\x1bx');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('type a message');
  });

  it('appends a space character correctly', async () => {
    const { lastFrame, typeText } = await renderChatInput();
    await typeText('a b');
    expect(lastFrame()).toContain('a b');
  });
});

// ---------------------------------------------------------------------------
// ChatInput — backspace
// ---------------------------------------------------------------------------

describe('ChatInput backspace', () => {
  afterEach(cleanup);

  it('removes the last character from the display', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await typeText('abc');
    // DEL (0x7f) is what most terminal emulators send for the Backspace key
    await sendRaw('\x7f');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ab');
    expect(frame).not.toContain('abc');
  });

  it('is a no-op when the field is already empty (no crash)', async () => {
    const { lastFrame, sendRaw } = await renderChatInput();
    await sendRaw('\x7f');
    // Should still render the idle hint without throwing
    expect(lastFrame()).toContain('type a message');
  });

  it('removes one character per keypress (not all)', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await typeText('xyz');
    await sendRaw('\x7f');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('xy');
    expect(frame).not.toContain('xyz');
  });
});

// ---------------------------------------------------------------------------
// ChatInput — Enter / submit
// ---------------------------------------------------------------------------

describe('ChatInput submit on Enter', () => {
  afterEach(cleanup);

  it('calls onSubmit with the current value when Enter is pressed', async () => {
    const { onSubmit, typeText, sendRaw } = await renderChatInput();
    await typeText('hello world');
    await sendRaw('\r');
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith('hello world');
  });

  it('clears the input field after a successful submit', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await typeText('hello');
    await sendRaw('\r');
    // Field should revert to idle/empty appearance
    expect(lastFrame()).toContain('type a message');
  });

  it('does not call onSubmit when Enter is pressed on an empty field', async () => {
    const { onSubmit, sendRaw } = await renderChatInput();
    await sendRaw('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not call onSubmit for whitespace-only input', async () => {
    const { onSubmit, typeText, sendRaw } = await renderChatInput();
    await typeText('   ');
    await sendRaw('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not call onSubmit for a tab-only value', async () => {
    const { onSubmit, sendRaw } = await renderChatInput();
    // Tab is treated as a key.tab special key by Ink, but even if appended as
    // a character it trims to empty — either way onSubmit must not fire.
    await sendRaw('\t');
    await sendRaw('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ChatInput — /model command
// ---------------------------------------------------------------------------

describe('ChatInput /model command', () => {
  afterEach(cleanup);

  it('calls onCommand("model-selector") instead of onSubmit when /model is entered', async () => {
    const { onSubmit, onCommand, typeText, sendRaw } = await renderChatInput();
    await typeText('/model');
    await sendRaw('\r');
    expect(onCommand).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenCalledWith('model-selector');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears the input after the /model command fires', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await typeText('/model');
    await sendRaw('\r');
    expect(lastFrame()).toContain('type a message');
  });

  it('does not crash and skips onSubmit when onCommand prop is absent', async () => {
    // When onCommand is omitted the component calls onCommand?.() which is a
    // no-op. onSubmit must also be skipped because /model matches the command
    // guard before the submit path.
    const onSubmit = vi.fn();
    const instance = render(<ChatInput onSubmit={onSubmit} />);
    // Give Ink one tick to register its stdin listener before writing.
    await tick();
    for (const ch of '/model') {
      instance.stdin.write(ch);
      await tick();
    }
    instance.stdin.write('\r');
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ChatInput — disabled state
// ---------------------------------------------------------------------------

describe('ChatInput disabled=true', () => {
  afterEach(cleanup);

  it('ignores character input when disabled', async () => {
    const { lastFrame, typeText } = await renderChatInput({ disabled: true });
    await typeText('blocked');
    // Text must not appear — streaming indicator should still be shown
    expect(lastFrame()).toContain('streaming');
    expect(lastFrame()).not.toContain('blocked');
  });

  it('ignores Enter key when disabled', async () => {
    const { onSubmit, sendRaw } = await renderChatInput({ disabled: true });
    await sendRaw('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores backspace when disabled', async () => {
    // Start in disabled mode; backspace must be a no-op
    const { lastFrame, sendRaw } = await renderChatInput({ disabled: true });
    await sendRaw('\x7f');
    // Still shows streaming indicator (field is empty, disabled)
    expect(lastFrame()).toContain('streaming');
  });

  it('renders correctly (no crash) when disabled=true', async () => {
    const { lastFrame } = await renderChatInput({ disabled: true });
    await tick();
    expect(lastFrame()).toBeDefined();
  });

  it('shows the streaming message instead of the cursor prompt when disabled and empty', async () => {
    const { lastFrame } = await renderChatInput({ disabled: true });
    await tick();
    // When disabled and field is empty the streaming indicator replaces the
    // cursor line. The cursor sequence "❯ │" must be absent; "⠿ streaming" present.
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⠿ streaming');
    // The cursor placement in the active component is "❯ │" immediately after
    // the prompt glyph. When disabled that sequence must not appear.
    expect(frame).not.toContain('❯ │');
  });
});

// ---------------------------------------------------------------------------
// ChatInput — history navigation
// ---------------------------------------------------------------------------

describe('ChatInput history navigation', () => {
  afterEach(cleanup);

  /** Submit a message by typing it and pressing Enter. */
  async function submitMessage(
    typeText: (t: string) => Promise<void>,
    sendRaw: (s: string) => Promise<void>,
    text: string,
  ) {
    await typeText(text);
    await sendRaw('\r');
  }

  it('Up arrow does nothing when history is empty', async () => {
    const { lastFrame, sendRaw } = await renderChatInput();
    await sendRaw('\x1b[A');
    // No crash; still shows idle hint
    expect(lastFrame()).toContain('type a message');
  });

  it('Up arrow recalls the last submitted message', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await submitMessage(typeText, sendRaw, 'first message');
    await sendRaw('\x1b[A');
    expect(lastFrame()).toContain('first message');
  });

  it('Up arrow cycles through multiple history entries most-recent-first', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await submitMessage(typeText, sendRaw, 'msg-one');
    await submitMessage(typeText, sendRaw, 'msg-two');

    // First Up → most recent
    await sendRaw('\x1b[A');
    expect(lastFrame()).toContain('msg-two');

    // Second Up → older entry
    await sendRaw('\x1b[A');
    expect(lastFrame()).toContain('msg-one');
  });

  it('Up arrow does not go below the oldest history entry', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await submitMessage(typeText, sendRaw, 'only');
    await sendRaw('\x1b[A');
    await sendRaw('\x1b[A'); // second press when already at oldest
    expect(lastFrame()).toContain('only');
  });

  it('Down arrow after Up restores the in-progress draft', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await submitMessage(typeText, sendRaw, 'past');

    // Start a new draft, then browse up and back down
    await typeText('wip');
    await sendRaw('\x1b[A'); // go to 'past'
    await sendRaw('\x1b[B'); // go back down → should restore 'wip'
    expect(lastFrame()).toContain('wip');
  });

  it('Down arrow is a no-op when not currently browsing history', async () => {
    const { lastFrame, sendRaw } = await renderChatInput();
    await sendRaw('\x1b[B');
    expect(lastFrame()).toContain('type a message');
  });

  it('Down arrow past the most-recent entry restores an empty draft', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await submitMessage(typeText, sendRaw, 'solo');
    await sendRaw('\x1b[A'); // at 'solo'
    await sendRaw('\x1b[B'); // past end → draft (empty)
    expect(lastFrame()).toContain('type a message');
  });

  it('editing after browsing up exits history mode', async () => {
    const { lastFrame, typeText, sendRaw } = await renderChatInput();
    await submitMessage(typeText, sendRaw, 'archived');
    await sendRaw('\x1b[A'); // recall 'archived'
    await sendRaw('\x7f'); // backspace — exits history mode, mutates a copy
    // The display now shows 'archive' (last char removed)
    expect(lastFrame()).toContain('archive');
  });
});

// ---------------------------------------------------------------------------
// ChatInput — multi-line / long input display
// ---------------------------------------------------------------------------

describe('ChatInput multi-line display', () => {
  afterEach(cleanup);

  it('shows all lines when input has fewer than 5 newlines', async () => {
    const { lastFrame, typeText } = await renderChatInput();
    // '\n' is a printable character from Ink's perspective (not a control key),
    // so it is appended to the value and split() produces multiple display lines.
    await typeText('line1\nline2\nline3');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line1');
    expect(frame).toContain('line3');
  });

  it('shows only the last 5 lines when there are more than 5', async () => {
    const { lastFrame, typeText } = await renderChatInput();
    // 7 lines: a through g. Lines a and b should be scrolled off.
    await typeText('a\nb\nc\nd\ne\nf\ng');
    const frame = lastFrame() ?? '';
    // Last two visible lines must appear
    expect(frame).toContain('g');
    expect(frame).toContain('f');
    // The very first line 'a' must not appear as a standalone token surrounded
    // by newlines (it was scrolled off the 5-line window).
    // We check for 'c' through 'g' appearing and 'a' not as a standalone word.
    expect(frame).not.toMatch(/\ba\b/);
  });
});
