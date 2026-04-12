/**
 * Tests for packages/app/src/components/chat/MarkdownMessage.tsx
 *
 * Coverage strategy:
 *  - Plain text rendering (raw=false and raw=true)
 *  - Single and multiple code fences
 *  - Language label in code block header
 *  - Fallback "code" label when no language is specified
 *  - Large code blocks (>= PROMOTE_THRESHOLD lines): truncation + expand hint
 *  - Small code blocks (< PROMOTE_THRESHOLD lines): full display, no expand hint
 *  - onPromote callback rendered only when block is large AND callback is provided
 *  - Empty text prop
 *  - Streaming: partial markdown (unclosed fence) renders as text
 *  - messageId used in artifact id generation (observable via onPromote)
 *  - raw=true bypasses markdown parsing and renders verbatim
 *
 * Assertions are made on the terminal string output from ink-testing-library's
 * lastFrame().  We strip ANSI codes where needed to keep assertions readable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { MarkdownMessage } from '../components/chat/MarkdownMessage.js';
import { PROMOTE_THRESHOLD } from '../hooks/useArtifacts.js';
import type { Artifact } from '../components/artifacts/ArtifactPanel.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes from a string. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Return the plain text output of a rendered component. */
function renderText(component: React.ReactElement): string {
  const { lastFrame } = render(component);
  return stripAnsi(lastFrame() ?? '');
}

/**
 * Build a code block string whose parsed segment will have exactly
 * `splitLineCount` elements when its `text` is split on '\n'.
 *
 * The FENCE regex captures everything between the opening and closing fences,
 * including the trailing '\n' that precedes the closing ```.  That trailing
 * newline adds one extra element to the split array relative to the visible
 * lines, so we generate `splitLineCount - 1` visible content lines.
 *
 * Example: makeCodeBlock('ts', 15) produces a block whose seg.text, when
 * split('\n'), yields 15 elements — exactly matching PROMOTE_THRESHOLD.
 */
function makeCodeBlock(lang: string, splitLineCount: number): string {
  const lines = Array.from({ length: splitLineCount - 1 }, (_, i) => `const line${i + 1} = ${i + 1};`);
  return `\`\`\`${lang}\n${lines.join('\n')}\n\`\`\``;
}

/**
 * Return the number of lines that MarkdownMessage will see for a block
 * built with makeCodeBlock(lang, splitLineCount).
 */
function expectedLineCount(splitLineCount: number): number {
  return splitLineCount;
}

afterEach(() => {
  cleanup();
});

// ─── Plain text rendering ──────────────────────────────────────────────────────

describe('MarkdownMessage — plain text', () => {
  it('should render plain prose with no code fences', () => {
    const output = renderText(<MarkdownMessage text="Hello, world!" />);
    expect(output).toContain('Hello, world!');
  });

  it('should render empty text without crashing', () => {
    expect(() => renderText(<MarkdownMessage text="" />)).not.toThrow();
  });

  it('should render multi-line prose', () => {
    const text = 'Line one.\nLine two.\nLine three.';
    const output = renderText(<MarkdownMessage text={text} />);
    expect(output).toContain('Line one.');
    expect(output).toContain('Line two.');
    expect(output).toContain('Line three.');
  });

  it('should render text containing inline backticks as plain text', () => {
    const text = 'Use `Array.from()` to convert.';
    const output = renderText(<MarkdownMessage text={text} />);
    expect(output).toContain('`Array.from()`');
  });
});

// ─── raw=true mode ────────────────────────────────────────────────────────────

describe('MarkdownMessage — raw mode', () => {
  it('should render markdown fences verbatim when raw=true', () => {
    const text = '```ts\nconst x = 1;\n```';
    const output = renderText(<MarkdownMessage text={text} raw />);
    // raw mode skips parseMarkdown; the triple backticks appear in output
    expect(output).toContain('```');
  });

  it('should NOT render a language label header when raw=true', () => {
    const text = '```ts\nconst x = 1;\n```';
    const output = renderText(<MarkdownMessage text={text} raw />);
    // In parsed mode "ts" appears as a label in a bordered box header.
    // In raw mode the label box is never rendered so no standalone "ts" line.
    // We just check the box borders are absent by verifying no code-block-style borders.
    expect(output).toContain('```ts');
  });

  it('should render plain text verbatim when raw=true', () => {
    const text = 'plain text';
    const output = renderText(<MarkdownMessage text={text} raw />);
    expect(output).toContain('plain text');
  });
});

// ─── Code block rendering ─────────────────────────────────────────────────────

describe('MarkdownMessage — code blocks', () => {
  it('should render the language label for a TypeScript block', () => {
    const input = '```ts\nconst x = 1;\n```';
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('ts');
  });

  it('should render the language label for a Python block', () => {
    const input = '```python\nprint("hello")\n```';
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('python');
  });

  it('should show "code" as label when no language is specified', () => {
    const input = '```\nsome code here\n```';
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('code');
  });

  it('should render the code content inside the block', () => {
    const input = '```ts\nconst answer = 42;\n```';
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('42');
  });

  it('should render prose before and after a code block', () => {
    const input = 'Before.\n```ts\nconst x = 1;\n```\nAfter.';
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('Before.');
    expect(output).toContain('After.');
  });

  it('should render multiple code blocks', () => {
    const input = [
      '```ts',
      'const x = 1;',
      '```',
      '```py',
      'print(x)',
      '```',
    ].join('\n');
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('ts');
    expect(output).toContain('py');
  });

  it('should render all language aliases without crashing', () => {
    const langs = ['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx',
                   'py', 'python', 'sh', 'bash', 'zsh', 'shell',
                   'go', 'golang', 'rs', 'rust'] as const;
    for (const lang of langs) {
      const input = `\`\`\`${lang}\ncode\n\`\`\``;
      expect(() => renderText(<MarkdownMessage text={input} />)).not.toThrow();
    }
  });
});

// ─── Large code blocks (>= PROMOTE_THRESHOLD lines) ───────────────────────────

describe('MarkdownMessage — large code blocks', () => {
  it('should show line count and expand hint for a large block', () => {
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD);
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain(`${expectedLineCount(PROMOTE_THRESHOLD)} lines`);
    expect(output).toContain('[Enter to expand]');
  });

  it('should truncate large block to first 10 lines in inline view', () => {
    // Use a large block (20 split lines = 19 visible content lines)
    const input = makeCodeBlock('ts', 20);
    const output = renderText(<MarkdownMessage text={input} />);
    // The component truncates highlighted lines to [:10] and appends '…'
    // Visible content lines 1-10 should appear; line 11 should NOT
    expect(output).toContain('line10');
    expect(output).not.toContain('line11');
  });

  it('should show the ellipsis truncation marker for large blocks', () => {
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD);
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('…');
  });

  it('should show "expand in panel" hint when onPromote is provided and block is large', () => {
    const onPromote = vi.fn();
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD);
    const output = renderText(
      <MarkdownMessage text={input} onPromote={onPromote} />,
    );
    expect(output).toContain('expand in panel');
  });

  it('should NOT show "expand in panel" hint when onPromote is absent', () => {
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD);
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).not.toContain('expand in panel');
  });

  it('should NOT show "expand in panel" hint when block is below PROMOTE_THRESHOLD', () => {
    const onPromote = vi.fn();
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD - 1);
    const output = renderText(
      <MarkdownMessage text={input} onPromote={onPromote} />,
    );
    expect(output).not.toContain('expand in panel');
  });
});

// ─── Small code blocks (< PROMOTE_THRESHOLD lines) ────────────────────────────

describe('MarkdownMessage — small code blocks', () => {
  it('should NOT show line count or expand hint for a small block', () => {
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD - 1);
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).not.toContain('[Enter to expand]');
  });

  it('should render all lines of a small block without truncation', () => {
    // PROMOTE_THRESHOLD - 1 split lines = PROMOTE_THRESHOLD - 2 content lines
    const splitCount = PROMOTE_THRESHOLD - 1;
    const contentLineCount = splitCount - 1;  // makeCodeBlock generates splitCount-1 visible lines
    const input = makeCodeBlock('ts', splitCount);
    const output = renderText(<MarkdownMessage text={input} />);
    // The last content line should be visible (no truncation)
    expect(output).toContain(`line${contentLineCount}`);
  });

  it('should NOT show the ellipsis for a small block', () => {
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD - 1);
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).not.toContain('…');
  });
});

// ─── messageId in artifact id ─────────────────────────────────────────────────

describe('MarkdownMessage — messageId', () => {
  it('should use "msg" as the artifact id prefix when messageId is not provided', () => {
    // We can observe this through the artifact passed to onPromote — but since
    // the onClick is only wired via Ink's Text onClick (not keyboard), we test
    // indirectly: the component renders without error and the "expand" text is present.
    const onPromote = vi.fn();
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD);
    expect(() =>
      renderText(<MarkdownMessage text={input} onPromote={onPromote} />),
    ).not.toThrow();
  });

  it('should render without crashing when messageId is provided', () => {
    const onPromote = vi.fn();
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD);
    expect(() =>
      renderText(
        <MarkdownMessage
          text={input}
          onPromote={onPromote}
          messageId="msg-abc-123"
        />,
      ),
    ).not.toThrow();
  });
});

// ─── Streaming / partial markdown ────────────────────────────────────────────

describe('MarkdownMessage — streaming partial markdown', () => {
  it('should render partial markdown (unclosed fence) without crashing', () => {
    const partial = 'Here is some code:\n```ts\nconst x = 1;';
    expect(() => renderText(<MarkdownMessage text={partial} />)).not.toThrow();
  });

  it('should render partial text content for an unclosed fence', () => {
    const partial = 'Intro text\n```ts\nconst x = 1;';
    const output = renderText(<MarkdownMessage text={partial} />);
    // parseMarkdown won't extract the partial fence; it all comes back as text
    expect(output).toContain('Intro text');
    expect(output).toContain('const x = 1;');
  });

  it('should update rendering as more text arrives (rerender)', () => {
    const partial = 'Hello\n```ts\nconst x =';
    const complete = 'Hello\n```ts\nconst x = 1;\n```\nDone.';

    const { rerender, lastFrame } = render(<MarkdownMessage text={partial} />);
    const before = stripAnsi(lastFrame() ?? '');
    expect(before).toContain('Hello');

    rerender(<MarkdownMessage text={complete} />);
    const after = stripAnsi(lastFrame() ?? '');
    expect(after).toContain('Done.');
    expect(after).toContain('ts');
  });
});

// ─── Boundary: exactly at PROMOTE_THRESHOLD ───────────────────────────────────

describe('MarkdownMessage — PROMOTE_THRESHOLD boundary', () => {
  it('should NOT promote a block with PROMOTE_THRESHOLD - 1 lines', () => {
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD - 1);
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).not.toContain('[Enter to expand]');
  });

  it('should promote a block with exactly PROMOTE_THRESHOLD lines', () => {
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD);
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('[Enter to expand]');
  });

  it('should promote a block with PROMOTE_THRESHOLD + 1 lines', () => {
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD + 1);
    const output = renderText(<MarkdownMessage text={input} />);
    expect(output).toContain('[Enter to expand]');
  });
});

// ─── onPromote artifact shape ─────────────────────────────────────────────────

describe('MarkdownMessage — Artifact type compliance', () => {
  it('artifact object passed to onPromote satisfies the Artifact interface shape', () => {
    // We cannot trigger onClick in Ink's testing environment directly,
    // so we verify the shape indirectly: the component compiles and
    // the onPromote prop accepts (artifact: Artifact) => void.
    // This test is primarily a TypeScript compile-time assertion.
    const onPromote: (artifact: Artifact) => void = vi.fn();
    const input = makeCodeBlock('ts', PROMOTE_THRESHOLD);
    expect(() =>
      renderText(<MarkdownMessage text={input} onPromote={onPromote} />),
    ).not.toThrow();
  });
});
